import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import slugify from 'slugify';

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  async create(createCategoryDto: CreateCategoryDto) {
    // 1. Cek Duplikat Nama
    const existing = await this.prisma.category.findUnique({
      where: { name: createCategoryDto.name },
    });
    if (existing) throw new BadRequestException('Kategori dengan nama ini sudah ada');

    // 2. Cek Validitas Parent (Jika ada parentId)
    if (createCategoryDto.parentId) {
      const parent = await this.prisma.category.findUnique({
        where: { id: BigInt(createCategoryDto.parentId) },
      });
      if (!parent) throw new BadRequestException('Parent Category ID tidak ditemukan!');
    }

    // 3. Buat Slug
    const slug = slugify(createCategoryDto.name, { lower: true });

    // 4. Simpan
    return this.prisma.category.create({
      data: {
        name: createCategoryDto.name,
        slug: slug,
        imageUrl: createCategoryDto.imageUrl,
        // Konversi ke BigInt jika ada, atau null jika tidak ada
        parentId: createCategoryDto.parentId ? BigInt(createCategoryDto.parentId) : null,
      },
    });
  }

  findAll() {
    return this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { 
        parent: true, // Tampilkan siapa bapaknya (opsional)
        children: true // Tampilkan siapa anaknya (opsional)
      } 
    });
  }

  findOne(id: number) {
    return this.prisma.category.findUnique({
      where: { id: BigInt(id) },
      include: {
        parent: true,
        children: true, // Biar kelihatan sub-kategorinya apa aja
      },
    });
  }

  async update(id: number, updateCategoryDto: UpdateCategoryDto) {
    // Cek Parent jika di-update
    if (updateCategoryDto.parentId) {
       // Cek apakah parent ada
        const parent = await this.prisma.category.findUnique({
        where: { id: BigInt(updateCategoryDto.parentId) },
      });
      if (!parent) throw new BadRequestException('Parent Category ID tidak ditemukan!');

      // Cek jangan sampai dia menjadi bapak dari dirinya sendiri (Infinite Loop)
      if (updateCategoryDto.parentId === id) {
        throw new BadRequestException('Kategori tidak bisa menjadi parent bagi dirinya sendiri!');
      }
    }

    const data: any = { ...updateCategoryDto };
    
    if (updateCategoryDto.name) {
      data.slug = slugify(updateCategoryDto.name, { lower: true });
    }
    
    // Handle BigInt conversion untuk update
    if (updateCategoryDto.parentId !== undefined) {
        data.parentId = updateCategoryDto.parentId ? BigInt(updateCategoryDto.parentId) : null;
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