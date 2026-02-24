import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import slugify from 'slugify';

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

  findAll() {
    return this.prisma.product.findMany({
      include: {
        category: true,
        brand: true,
        variants: true,
      },
      orderBy: { createdAt: 'desc' },
    });
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

  // Update dan Remove kita skip dulu sementara, fokus ke Create & Read
  update(id: number, updateProductDto: UpdateProductDto) {
    return `This action updates a #${id} product`;
  }

  remove(id: number) {
    return `This action removes a #${id} product`;
  }
}