import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import slugify from 'slugify';

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  async create(createCategoryDto: CreateCategoryDto) {
    // 1. Cek Duplikat (Pakai findUnique karena di schema sudah @unique)
    const existing = await this.prisma.category.findUnique({
      where: { name: createCategoryDto.name },
    });

    if (existing) {
      throw new BadRequestException('Kategori dengan nama ini sudah ada');
    }

    // 2. Buat Slug otomatis
    const slug = slugify(createCategoryDto.name, { lower: true });

    // 3. Simpan
    return this.prisma.category.create({
      data: {
        ...createCategoryDto,
        slug,
      },
    });
  }

  findAll() {
    return this.prisma.category.findMany({
      orderBy: { name: 'asc' },
    });
  }

  findOne(id: number) {
    // Convert id ke BigInt karena schema Anda pakai BigInt
    return this.prisma.category.findUnique({
      where: { id: BigInt(id) },
    });
  }

  update(id: number, updateCategoryDto: UpdateCategoryDto) {
    const data: any = { ...updateCategoryDto };
    
    // Update slug jika nama berubah
    if (updateCategoryDto.name) {
      data.slug = slugify(updateCategoryDto.name, { lower: true });
    }

    return this.prisma.category.update({
      where: { id: BigInt(id) },
      data,
    });
  }

  remove(id: number) {
    return this.prisma.category.delete({
      where: { id: BigInt(id) },
    });
  }
}