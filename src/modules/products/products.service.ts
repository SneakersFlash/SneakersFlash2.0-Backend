import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import slugify from 'slugify';
import { ProductQueryDto } from './dto/product-query.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  async create(createProductDto: CreateProductDto) {
    const existingProduct = await this.prisma.product.findFirst({
      where: { name: createProductDto.name },
    });
    if (existingProduct) throw new BadRequestException('Produk dengan nama ini sudah ada!');

    const skus = createProductDto.variants.map(v => v.sku);
    const existingSkus = await this.prisma.productVariant.findMany({
      where: { sku: { in: skus } },
    });
    if (existingSkus.length > 0) {
      throw new BadRequestException(`SKU bentrok/sudah terpakai: ${existingSkus.map(s => s.sku).join(', ')}`);
    }

    const slug = slugify(createProductDto.name, { lower: true }) + '-' + Date.now();

    return this.prisma.product.create({
      data: {
        // ⚠️ CHANGED: Menggunakan relasi array 'categories' dengan connect
        // Asumsi DTO sekarang mengirimkan array 'categoryIds'
        categories: createProductDto['categoryIds'] ? {
            connect: createProductDto['categoryIds'].map((id: any) => ({ id: BigInt(id) }))
        } : undefined,

        brandId: createProductDto.brandId ? BigInt(createProductDto.brandId) : null,
        name: createProductDto.name,
        slug: slug,
        description: createProductDto.description,
        basePrice: createProductDto.basePrice,
        weightGrams: createProductDto.weightGrams,
        variants: {
          create: createProductDto.variants.map((variant) => ({
            sku: variant.sku,
            price: variant.price,
            stockQuantity: variant.stockQuantity,
            imageUrl: variant['imageUrl'] ?? (variant['imageUrl'] ? [variant['imageUrl']] : []), 
          })),
        },
      },
      include: {
        variants: true,
        categories: true, // ⚠️ CHANGED: category -> categories
        brand: true,
      },
    });
  }

  async findAll(query: ProductQueryDto) {
    const { 
      page = 1, 
      limit = 10, 
      search, 
      category, // ⚠️ UBAH: Ambil nama kategori dari query
      brand,    // ⚠️ UBAH: Ambil nama brand dari query
      sortBy = 'createdAt', 
      sortOrder = 'desc' 
    } = query;

    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = {
      isActive: true, 
      AND: []
    };

    // 1. Filter Pencarian Umum (Search)
    if (search) {
      (where.AND as any[]).push({
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { brand: { name: { contains: search, mode: 'insensitive' } } },
          { variants: { some: { sku: { contains: search, mode: 'insensitive' } } } }
        ]
      });
    }

    // 2. ⚠️ FILTER BY CATEGORY NAME (Many-to-Many)
    if (category) {
        (where.AND as any[]).push({ 
            categories: { 
                // Cari produk yang SALAH SATU kategorinya punya nama yang cocok
                some: { 
                    name: { equals: category, mode: 'insensitive' } 
                } 
            } 
        });
    }
    
    // 3. ⚠️ FILTER BY BRAND NAME (One-to-Many)
    if (brand) {
        (where.AND as any[]).push({ 
            brand: { 
                name: { equals: brand, mode: 'insensitive' } 
            } 
        });
    }

    let orderBy: Prisma.ProductOrderByWithRelationInput = {};
    if (sortBy === 'price') {
      orderBy = { basePrice: sortOrder };
    } else if (sortBy === 'name') {
      orderBy = { name: sortOrder };
    } else {
      orderBy = { createdAt: sortOrder };
    }

    // Eksekusi Query
    const [rawProducts, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          categories: true, 
          brand: true,
          eventProducts: {
            where: {
              event: {
                isActive: true,
                startAt: { lte: new Date() },
                endAt: { gte: new Date() }
              }
            },
            include: { event: true },
          },
          variants: {
            where: { isActive: true }, 
            include: {
              variantOptions: {
                include: {
                  optionValue: {
                    include: { option: true } 
                  }
                }
              }
            }
          },
          wishlists: true,
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    const formattedData = rawProducts.map((product) => {
      const sizeSet = new Set<string>();
      
      product.variants.forEach((v) => {
        v.variantOptions.forEach((vo) => {
          const optName = vo.optionValue.option.name.toLowerCase();
          if (optName.includes('size') || optName.includes('ukuran')) {
            sizeSet.add(vo.optionValue.value);
          }
        });
      });

      const sortedSizes = Array.from(sizeSet).sort((a, b) => {
        const numA = parseFloat(a);
        const numB = parseFloat(b);
        return (!isNaN(numA) && !isNaN(numB)) ? numA - numB : a.localeCompare(b);
      });

      const activeEvent = product.eventProducts?.[0];
      return {
        ...product,
        id: product.id.toString(),
        brandId: product.brandId ? product.brandId.toString() : null,
        basePrice: Number(product.basePrice), 
        weightGrams: Number(product.weightGrams),
        
        activeEvent: activeEvent ? {
            eventName: activeEvent.event?.title ?? null,
            specialPrice: activeEvent.specialPrice ? Number(activeEvent.specialPrice) : null,
            quotaLimit: activeEvent.quotaLimit,
            quotaSold: activeEvent.quotaSold
        } : null,

        categories: product.categories.map(c => ({
            id: c.id.toString(),
            name: c.name,
            slug: c.slug
        })),

        availableSizes: sortedSizes, 
        totalStock: product.variants.reduce((acc, v) => acc + v.stockQuantity, 0),
        
        variants: product.variants.map(v => ({
            id: v.id.toString(),
            sku: v.sku,
            price: Number(v.price),
            stock: v.stockQuantity,
            imageUrl: v?.imageUrl
        }))
      };
    });

    return {
      data: formattedData,
      meta: {
        total,
        page,
        limit,
        lastPage: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1,
      },
    };
  }

  findOne(id: number) {
    return this.prisma.product.findUnique({
      where: { id: BigInt(id) },
      include: {
        categories: true, // ⚠️ CHANGED: category -> categories
        brand: true,
        variants: true,
      },
    });
  }

  async findBySlug(identifier: string) {
    // Cek apakah identifier hanya berisi angka (berarti ID), jika tidak berarti Slug
    const isNumeric = /^\d+$/.test(identifier);

    const product = await this.prisma.product.findFirst({
      where: isNumeric ? { id: BigInt(identifier) } : { slug: identifier },
      include: {
        categories: true, 
        brand: true,
        eventProducts: {
          where: {
            event: { isActive: true, startAt: { lte: new Date() }, endAt: { gte: new Date() } }
          },
          include: { event: true },
        },
        variants: {
          where: { isActive: true },
          include: {
            variantOptions: {
              include: {
                optionValue: {
                  include: { option: true }
                }
              }
            }
          }
        },
      },
    });

    if (!product) {
      throw new BadRequestException('Produk tidak ditemukan');
    }

    const activeEvent = product.eventProducts?.[0];
    
    return {
      ...product,
      id: product.id.toString(),
      brandId: product.brandId ? product.brandId.toString() : null,
      basePrice: Number(product.basePrice),
      weightGrams: Number(product.weightGrams),
      activeEvent: activeEvent ? {
          eventName: activeEvent.event?.title ?? null,
          specialPrice: activeEvent.specialPrice ? Number(activeEvent.specialPrice) : null,
          quotaLimit: activeEvent.quotaLimit,
          quotaSold: activeEvent.quotaSold
      } : null,
      categories: product.categories.map(c => ({
        id: c.id.toString(),
        name: c.name,
        slug: c.slug
      })),
      
      // Format varian agar Frontend mudah membacanya (terutama untuk UI Size)
      variants: product.variants.map(v => {
        // Cari ukuran dari relasi variantOptions
        const sizeOption = v.variantOptions.find(vo => {
          const optName = vo.optionValue.option.name.toLowerCase();
          return optName.includes('size') || optName.includes('ukuran');
        });

        return {
          id: v.id.toString(),
          sku: v.sku,
          price: Number(v.price),
          stock: v.stockQuantity,
          imageUrl: v.imageUrl,
          // Jika tidak ada ukuran spesifik, default ke "All Size" / "OS"
          size: sizeOption ? sizeOption.optionValue.value : "OS" 
        };
      })
    };
  }
  
  async update(id: number, updateProductDto: UpdateProductDto) {
    const existingProduct = await this.prisma.product.findUnique({
      where: { id: BigInt(id) },
    });

    if (!existingProduct) {
      throw new BadRequestException(`Produk dengan ID ${id} tidak ditemukan`);
    }

    const { variants, ...productData } = updateProductDto;

    let newSlug = existingProduct.slug;
    if (productData.name && productData.name !== existingProduct.name) {
      newSlug = slugify(productData.name, { lower: true }) + '-' + Date.now();
    }
    
    return this.prisma.product.update({
      where: { id: BigInt(id) },
      data: {
        ...productData,
        slug: newSlug,
        brandId: productData.brandId ? BigInt(productData.brandId) : undefined,
        
        // ⚠️ CHANGED: Gunakan set untuk mengganti/menimpa relasi kategori
        categories: productData['categoryIds'] ? {
            set: productData['categoryIds'].map((catId: any) => ({ id: BigInt(catId) }))
        } : undefined,
        
        variants: variants ? {
          upsert: variants.map((v) => ({
            where: { sku: v.sku },
            update: {
              price: v.price,
              stockQuantity: v.stockQuantity,
              imageUrl: v['imageUrl'] ?? (v['imageUrl'] ? [v['imageUrl']] : []),
            },
            create: {
              sku: v.sku,
              price: v.price,
              stockQuantity: v.stockQuantity,
              imageUrl: v['imageUrl'] ?? (v['imageUrl'] ? [v['imageUrl']] : []),
            },
          })),
        } : undefined,
      },
      include: {
        variants: true,
        brand: true,
        categories: true, // ⚠️ CHANGED: category -> categories
      },
    });
  }

  async remove(id: number) {
    const existingProduct = await this.prisma.product.findUnique({
      where: { id: BigInt(id) },
    });

    if (!existingProduct) {
      throw new BadRequestException(`Produk dengan ID ${id} tidak ditemukan`);
    }

    // Prisma otomatis menghapus relasi Many-to-Many di join table
    try {
      return await this.prisma.product.delete({
        where: { id: BigInt(id) },
      });
    } catch (error) {
      await this.prisma.productVariant.deleteMany({
        where: { productId: BigInt(id) }
      });
      
      return await this.prisma.product.delete({
        where: { id: BigInt(id) },
      });
    }
  }
}