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
    // 1. Cek Duplikat Nama Produk
    const existingProduct = await this.prisma.product.findFirst({
      where: { name: createProductDto.name },
    });
    if (existingProduct) throw new BadRequestException('Produk dengan nama ini sudah ada!');

    // 2. Cek apakah SKU Varian ada yang bentrok / kembar di seluruh database
    const skus = createProductDto.variants.map(v => v.sku);
    const existingSkus = await this.prisma.productVariant.findMany({
      where: { sku: { in: skus } },
    });
    if (existingSkus.length > 0) {
      throw new BadRequestException(`SKU bentrok/sudah terpakai: ${existingSkus.map(s => s.sku).join(', ')}`);
    }

    // 3. Generate Slug untuk URL Produk
    const slug = slugify(createProductDto.name, { lower: true }) + '-' + Date.now();

    // 4. SIMPAN DENGAN PRISMA TRANSACTION (Nested Writes)
    return this.prisma.product.create({
      data: {
        categoryId: BigInt(createProductDto.categoryId),
        brandId: createProductDto.brandId ? BigInt(createProductDto.brandId) : null,
        name: createProductDto.name,
        slug: slug,
        description: createProductDto.description,
        basePrice: createProductDto.basePrice,
        weightGrams: createProductDto.weightGrams,
        // Insert Variant sekaligus!
        variants: {
          create: createProductDto.variants.map((variant) => ({
            sku: variant.sku,
            price: variant.price,
            stockQuantity: variant.stockQuantity,
            imageUrl: variant.imageUrl,
          })),
        },
      },
      // Beritahu Prisma untuk mengembalikan data varian & kategori yang baru dibuat
      include: {
        variants: true,
        category: true,
        brand: true,
      },
    });
  }

  async findAll(query: ProductQueryDto) {
    const { 
      page = 1, 
      limit = 10, 
      search, 
      categoryId, 
      brandId, 
      sortBy = 'createdAt', 
      sortOrder = 'desc' 
    } = query;

    const skip = (page - 1) * limit;

    // 1. SETUP WHERE CLAUSE (Filter)
    // Saya pertahankan logika filter Anda yang sudah benar
    const where: Prisma.ProductWhereInput = {
      isActive: true, // Tambahan: Sebaiknya hanya tampilkan produk aktif
      AND: []
    };

    // Handle Search
    if (search) {
      (where.AND as any[]).push({
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { brand: { name: { contains: search, mode: 'insensitive' } } },
          { variants: { some: { sku: { contains: search, mode: 'insensitive' } } } }
        ]
      });
    }

    // Handle Category & Brand
    if (categoryId) (where.AND as any[]).push({ categoryId: BigInt(categoryId) });
    if (brandId) (where.AND as any[]).push({ brandId: BigInt(brandId) });


    // 2. SETUP ORDER BY
    let orderBy: Prisma.ProductOrderByWithRelationInput = {};
    if (sortBy === 'price') {
      orderBy = { basePrice: sortOrder };
    } else if (sortBy === 'name') {
      orderBy = { name: sortOrder };
    } else {
      orderBy = { createdAt: sortOrder };
    }

    // 3. EXECUTE QUERY
    const [rawProducts, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          category: true,
          brand: true,
          // --- PERUBAHAN DISINI: DEEP INCLUDE ---
          variants: {
            where: { isActive: true }, // Hanya ambil varian aktif
            include: {
              variantOptions: {
                include: {
                  optionValue: {
                    include: { option: true } // Ambil nama option ("Size")
                  }
                }
              }
            }
          },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    // 4. MAPPING DATA (Flattening & Formatting)
    // Kita ubah struktur nested object yang rumit menjadi array simple ["40", "41"]
    const formattedData = rawProducts.map((product) => {
      // Logic Ekstrak Size
      const sizeSet = new Set<string>();
      
      product.variants.forEach((v) => {
        v.variantOptions.forEach((vo) => {
          // Cek case-insensitive (Size, size, SIZE, Ukuran, dll)
          const optName = vo.optionValue.option.name.toLowerCase();
          if (optName.includes('size') || optName.includes('ukuran')) {
            sizeSet.add(vo.optionValue.value);
          }
        });
      });

      // Sort Size (Numerik agar 9 tidak lebih besar dari 10)
      const sortedSizes = Array.from(sizeSet).sort((a, b) => {
        const numA = parseFloat(a);
        const numB = parseFloat(b);
        return (!isNaN(numA) && !isNaN(numB)) ? numA - numB : a.localeCompare(b);
      });

      // Return Data Bersih (Handle BigInt juga disini)
      return {
        ...product,
        id: product.id.toString(),
        categoryId: product.categoryId.toString(),
        brandId: product.brandId ? product.brandId.toString() : null,
        basePrice: Number(product.basePrice), // Convert Decimal ke Number JS
        weightGrams: Number(product.weightGrams),
        
        // Field baru untuk Frontend
        availableSizes: sortedSizes, 
        totalStock: product.variants.reduce((acc, v) => acc + v.stockQuantity, 0),
        
        // Bersihkan data nested yang terlalu dalam agar response ringan
        variants: product.variants.map(v => ({
            id: v.id.toString(),
            sku: v.sku,
            price: Number(v.price),
            stock: v.stockQuantity,
            imageUrl: v.imageUrl
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
        category: true,
        brand: true,
        variants: true,
      },
    });
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
        categoryId: productData.categoryId ? BigInt(productData.categoryId) : undefined,
        
        variants: variants ? {
          upsert: variants.map((v) => ({
            where: { sku: v.sku },
            update: {
              price: v.price,
              stockQuantity: v.stockQuantity,
              imageUrl: v.imageUrl,
            },
            create: {
              sku: v.sku,
              price: v.price,
              stockQuantity: v.stockQuantity,
              imageUrl: v.imageUrl,
            },
          })),
        } : undefined,
      },
      include: {
        variants: true,
        brand: true,
        category: true,
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