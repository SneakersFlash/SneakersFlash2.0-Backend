import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import slugify from 'slugify'; // Import slugify

@Injectable()
export class BrandsService {
  constructor(private prisma: PrismaService) {}

  async create(createBrandDto: CreateBrandDto) {
    // 1. Cek duplikat
    const existing = await this.prisma.brand.findUnique({
      where: { name: createBrandDto.name },
    });
    if (existing) throw new BadRequestException('Brand sudah ada');

    // 2. Buat Slug
    const slug = slugify(createBrandDto.name, { lower: true });

    // 3. Simpan
    return this.prisma.brand.create({
      data: {
        ...createBrandDto,
        slug,
      },
    });
  }

  findAll() {
    return this.prisma.brand.findMany({
      orderBy: { name: 'asc' }, // Urutkan A-Z
    });
  }

  findOne(id: number) {
    return this.prisma.brand.findUnique({ where: { id } });
  }

  update(id: number, updateBrandDto: UpdateBrandDto) {
    // Kalau nama diganti, slug juga harus ganti
    const data: any = { ...updateBrandDto };
    if (updateBrandDto.name) {
      data.slug = slugify(updateBrandDto.name, { lower: true });
    }
    
    return this.prisma.brand.update({
      where: { id },
      data,
    });
  }

  remove(id: number) {
    return this.prisma.brand.delete({ where: { id } });
  }
}