import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto'; // Nanti kita buat DTO-nya
import { UpdateEventDto } from './dto/update-event.dto';

@Injectable()
export class EventsService {
  constructor(private prisma: PrismaService) { }

  // ===================================
  // ADMIN FEATURES
  // ===================================

  async create(dto: CreateEventDto) {
    // Cek slug unik
    const existing = await this.prisma.event.findUnique({ where: { slug: dto.slug } });
    if (existing) throw new BadRequestException('Slug event sudah digunakan!');

    return await this.prisma.event.create({
      data: {
        title: dto.title,
        slug: dto.slug,
        bannerDesktopUrl: dto.bannerDesktopUrl,
        bannerMobileUrl: dto.bannerMobileUrl,
        contentHtml: dto.contentHtml,
        styleConfig: dto.styleConfig, // JSON tema warna dll
        startAt: new Date(dto.startAt),
        endAt: new Date(dto.endAt),
        isActive: dto.isActive ?? true,
      }
    });
  }
  async findAllAdmin() {
    const events = await this.prisma.event.findMany({
      orderBy: { id: 'desc' },
      include: {
        _count: {
          select: { eventProducts: true } // Menghitung jumlah produk di event ini
        }
      }
    });

    return events.map(e => ({
      ...e,
      id: e.id.toString(),
    }));
  }
  async update(id: number, dto: UpdateEventDto) {
    const eventId = BigInt(id);
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Event tidak ditemukan!');

    // Cek jika slug diubah, pastikan tidak duplikat dengan yang lain
    if (dto.slug && dto.slug !== event.slug) {
      const existing = await this.prisma.event.findUnique({ where: { slug: dto.slug } });
      if (existing) throw new BadRequestException('Slug event sudah digunakan!');
    }

    const updated = await this.prisma.event.update({
      where: { id: eventId },
      data: {
        title: dto.title,
        slug: dto.slug,
        bannerDesktopUrl: dto.bannerDesktopUrl,
        bannerMobileUrl: dto.bannerMobileUrl,
        contentHtml: dto.contentHtml,
        styleConfig: dto.styleConfig,
        startAt: dto.startAt ? new Date(dto.startAt) : undefined,
        endAt: dto.endAt ? new Date(dto.endAt) : undefined,
        isActive: dto.isActive,
      }
    });

    return { ...updated, id: updated.id.toString() };
  }

  async remove(id: number) {
    const eventId = BigInt(id);
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Event tidak ditemukan!');

    await this.prisma.event.delete({
      where: { id: eventId }
    });

    return { message: 'Event berhasil dihapus' };
  }

  async addProductToEvent(eventId: number, productId: number, specialPrice: number, quota: number) {
    // Cek duplikat
    const exists = await this.prisma.eventProduct.findUnique({
      where: { eventId_productId: { eventId: BigInt(eventId), productId: BigInt(productId) } }
    });

    if (exists) throw new BadRequestException('Produk sudah ada di event ini.');

    return await this.prisma.eventProduct.create({
      data: {
        eventId: BigInt(eventId),
        productId: BigInt(productId),
        specialPrice: specialPrice,
        quotaLimit: quota,
        quotaSold: 0,
        displayOrder: 0 // Default urutan
      }
    });
  }

  // ===================================
  // PUBLIC / STOREFRONT FEATURES
  // ===================================

  // API yang ditembak Next.js saat buka sneakersflash.com/promo/lebaran
  async findBySlug(slug: string) {
    const event = await this.prisma.event.findUnique({
      where: { slug: slug, isActive: true },
      include: {
        eventProducts: {
          include: {
            product: {
              include: {
                variants: true, // Ambil varian buat cek stok/harga asli
                brand: true
              }
            }
          },
          orderBy: { displayOrder: 'asc' }
        }
      }
    });

    if (!event) throw new NotFoundException('Event tidak ditemukan atau sudah berakhir.');

    // Cek Tanggal
    const now = new Date();
    if (now < event.startAt) throw new BadRequestException('Event belum dimulai! Tunggu ya.');
    if (now > event.endAt) throw new BadRequestException('Event sudah berakhir.');

    // Transform Data untuk Frontend (BigInt handling)
    return {
      id: event.id.toString(),
      title: event.title,
      bannerDesktop: event.bannerDesktopUrl,
      bannerMobile: event.bannerMobileUrl,
      htmlContent: event.contentHtml,
      style: event.styleConfig, // Warna background, font color, dll
      countDownEnd: event.endAt,

      products: event.eventProducts.map(ep => {
        // Logic: Harga Flash Sale vs Harga Asli
        const basePrice = Number(ep.product.basePrice);
        const promoPrice = ep.specialPrice ? Number(ep.specialPrice) : basePrice;
        const discountPercent = Math.round(((basePrice - promoPrice) / basePrice) * 100);

        // Cek Quota Flash Sale
        const isSoldOut = ep.quotaLimit > 0 && ep.quotaSold >= ep.quotaLimit;

        return {
          productId: ep.productId.toString(),
          name: ep.product.name,
          slug: ep.product.slug,
          image: ep.product.variants[0]?.imageUrl, // Ambil gambar varian pertama
          originalPrice: basePrice,
          finalPrice: promoPrice,
          discountPercent: discountPercent > 0 ? discountPercent : null,
          isFlashSale: !!ep.specialPrice,
          isSoldOut: isSoldOut,
          stockBar: ep.quotaLimit > 0 ? { total: ep.quotaLimit, sold: ep.quotaSold } : null
        };
      })
    };
  }

  // List event yang sedang aktif (untuk taruh di Homepage Carousel)
  async findActiveEvents() {
    const now = new Date();
    return await this.prisma.event.findMany({
      where: {
        isActive: true,
        startAt: { lte: now },
        endAt: { gte: now }
      },
      select: {
        id: true,
        title: true,
        slug: true,
        bannerDesktopUrl: true
      }
    });
  }
}