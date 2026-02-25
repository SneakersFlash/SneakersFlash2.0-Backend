import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateBannerDto } from './dto/create-banner.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';
import { BannerPosition } from '@prisma/client';

@Injectable()
export class BannersService {
  constructor(private prisma: PrismaService) { }

  // 1. Create (Admin)
  async create(dto: CreateBannerDto) {
    return await this.prisma.banner.create({
      data: {
        title: dto.title,
        imageDesktopUrl: dto.imageDesktopUrl,
        imageMobileUrl: dto.imageMobileUrl,
        targetUrl: dto.targetUrl,
        position: dto.position,
        sortOrder: dto.sortOrder || 0,
        isActive: dto.isActive ?? true,
        startAt: new Date(), // Default sekarang
      }
    });
  }

  // 2. Find All (Public - Filter by Position)
  async findAll(position?: BannerPosition) {
    const banners = await this.prisma.banner.findMany({
      where: {
        isActive: true, // Hanya yang aktif
        position: position ? position : undefined, // Filter posisi jika ada param
      },
      orderBy: { sortOrder: 'asc' } // Urutkan 1, 2, 3
    });

    // Serialisasi BigInt
    return banners.map(b => ({
      ...b,
      id: b.id.toString()
    }));
  }

  // 3. Find All Raw (Admin - Lihat semua termasuk non-aktif)
  async findAllAdmin() {
    const banners = await this.prisma.banner.findMany({
      orderBy: { id: 'desc' }
    });
    return banners.map(b => ({ ...b, id: b.id.toString() }));
  }

  // 4. Find One
  async findOne(id: number) {
    const banner = await this.prisma.banner.findUnique({
      where: { id: BigInt(id) }
    });
    if (!banner) throw new NotFoundException('Banner not found');
    return { ...banner, id: banner.id.toString() };
  }

  // 5. Update (Admin)
  async update(id: number, dto: UpdateBannerDto) {
    await this.findOne(id);
    const updated = await this.prisma.banner.update({
      where: { id: BigInt(id) },
      data: dto
    });
    return { ...updated, id: updated.id.toString() };
  }

  // 6. Delete (Admin)
  async remove(id: number) {
    await this.findOne(id);
    return await this.prisma.banner.delete({
      where: { id: BigInt(id) }
    });
  }
}