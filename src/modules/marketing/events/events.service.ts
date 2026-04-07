import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto'; // Nanti kita buat DTO-nya
import { UpdateEventDto } from './dto/update-event.dto';
import { google } from 'googleapis';

@Injectable()
export class EventsService {
  logger: any;
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

  async addProductToEvent(eventId: number, productVariantId: number, specialPrice: number, quota: number) {
    const exists = await this.prisma.eventProduct.findUnique({
      where: { 
        eventId_productVariantId: { 
          eventId: BigInt(eventId), 
          productVariantId: BigInt(productVariantId) 
        } 
      }
    });

    if (exists) throw new BadRequestException('Varian produk sudah ada di event ini.');

    return await this.prisma.eventProduct.create({
      data: {
        eventId: BigInt(eventId),
        productVariantId: BigInt(productVariantId), 
        specialPrice: specialPrice,
        quotaLimit: quota,
        quotaSold: 0,
        displayOrder: 0 
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
            variant: { 
              include: {
                product: {
                  include: {
                    brand: true
                  }
                }
              }
            }
          },
          orderBy: { displayOrder: 'asc' }
        }
      }
    });

    if (!event) throw new NotFoundException('Event tidak ditemukan atau sudah berakhir.');

    const now = new Date();
    if (now < event.startAt) throw new BadRequestException('Event belum dimulai! Tunggu ya.');
    if (now > event.endAt) throw new BadRequestException('Event sudah berakhir.');

    return {
      id: event.id.toString(),
      title: event.title,
      bannerDesktop: event.bannerDesktopUrl,
      bannerMobile: event.bannerMobileUrl,
      htmlContent: event.contentHtml,
      style: event.styleConfig,
      countDownEnd: event.endAt,

      products: event.eventProducts.map(ep => {
        const basePrice = Number(ep.variant.price); 
        const promoPrice = ep.specialPrice ? Number(ep.specialPrice) : basePrice;
        const discountPercent = Math.round(((basePrice - promoPrice) / basePrice) * 100);

        const isSoldOut = ep.quotaLimit > 0 && ep.quotaSold >= ep.quotaLimit;

        return {
          productVariantId: ep.productVariantId.toString(),
          productId: ep.variant.productId.toString(),
          name: `${ep.variant.product.name} (SKU: ${ep.variant.sku})`, 
          slug: ep.variant.product.slug,
          image: ep.variant.imageUrl && ep.variant.imageUrl.length > 0 ? ep.variant.imageUrl[0] : null, 
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

  async syncEventProductsFromSheet(eventId: number, sheetUrl: string, sheetName: string) {
    const eventIdBigInt = BigInt(eventId);
    
    // 1. Pastikan Event ada
    const event = await this.prisma.event.findUnique({ where: { id: eventIdBigInt } });
    if (!event) throw new NotFoundException('Event tidak ditemukan!');

    // 2. Ekstrak Spreadsheet ID dari URL
    // URL Google Sheet biasanya: https://docs.google.com/spreadsheets/d/1BxiMVs0X_5u.../edit
    const regex = /\/d\/([a-zA-Z0-9-_]+)/;
    const match = sheetUrl.match(regex);
    if (!match) {
      throw new BadRequestException('Format URL Google Sheet tidak valid. Pastikan link mengandung ID dokumen.');
    }
    const spreadsheetId = match[1];

    // 3. Setup Auth Google Sheets
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const range = `${sheetName}!A1:Z1000`; // Asumsi maksimal 1000 produk per event
    
    this.logger.log(`Syncing Event ${eventId} from Sheet ID: ${spreadsheetId}, Range: ${range}`);

    try {
      // 4. Tarik Data dari Google Sheet
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        throw new BadRequestException('Tidak ada data yang ditemukan di dalam spreadsheet.');
      }

      // 5. Mapping Header
      const headers = rows[0].map((h) => h.toLowerCase().trim().replace(/ /g, '_'));
      if (!headers.includes('sku')) {
        throw new BadRequestException('Sheet harus memiliki kolom "sku".');
      }

      const getValue = (row: any[], colName: string) => {
        const index = headers.indexOf(colName);
        return index !== -1 ? (row[index] ? row[index].toString().trim() : null) : null;
      };

      const dataRows = rows.slice(1);
      let successCount = 0;
      let notFoundSkus: string[] = [];

      // 6. Looping Data dan Upsert ke Database
      for (const row of dataRows) {
        const sku = getValue(row, 'sku');
        if (!sku) continue;

        // Cari Variant berdasarkan SKU
        const variant = await this.prisma.productVariant.findUnique({
          where: { sku: sku }
        });

        if (!variant) {
          notFoundSkus.push(sku);
          continue;
        }

        const specialPrice = parseFloat(getValue(row, 'special_price') || '0');
        const quotaLimit = parseInt(getValue(row, 'quota_limit') || '0', 10);
        const displayOrder = parseInt(getValue(row, 'display_order') || '0', 10);

        // Upsert EventProduct (Jika SKU sudah ada di event, update harganya. Jika belum, tambahkan) 
        await this.prisma.eventProduct.upsert({
          where: {
            eventId_productVariantId: {
              eventId: eventIdBigInt,
              productVariantId: variant.id
            }
          },
          update: {
            specialPrice: specialPrice > 0 ? specialPrice : null,
            quotaLimit: quotaLimit,
            displayOrder: displayOrder,
          },
          create: {
            eventId: eventIdBigInt,
            productVariantId: variant.id,
            specialPrice: specialPrice > 0 ? specialPrice : null,
            quotaLimit: quotaLimit,
            quotaSold: 0,
            displayOrder: displayOrder,
          }
        });

        successCount++;
      }

      return { 
        status: 'success', 
        message: `Berhasil sinkronisasi ${successCount} produk ke event ${event.title}.`,
        warning: notFoundSkus.length > 0 ? `SKU tidak ditemukan di database: ${notFoundSkus.join(', ')}` : null
      };

    } catch (error: any) {
      this.logger.error('Google Sheet Sync Error:', error);
      // Tangani error izin (403) agar pesannya lebih jelas untuk Admin
      if (error.code === 403) {
        throw new BadRequestException('Akses ditolak oleh Google. Pastikan file Spreadsheet sudah di-share (Viewer) ke email Service Account Anda.');
      }
      throw new BadRequestException(`Gagal membaca sheet: ${error.message}`);
    }
  }

  async findEventProductsAdmin(eventId: number) {
    const products = await this.prisma.eventProduct.findMany({
      where: { eventId: BigInt(eventId) },
      include: {
        variant: {
          include: {
            product: true
          }
        }
      },
      orderBy: { displayOrder: 'asc' }
    });

    // Format data agar mudah dibaca oleh frontend
    return products.map(ep => ({
      eventId: ep.eventId.toString(),
      productVariantId: ep.productVariantId.toString(),
      sku: ep.variant.sku,
      productName: ep.variant.product.name,
      originalPrice: Number(ep.variant.price),
      specialPrice: ep.specialPrice ? Number(ep.specialPrice) : null,
      quotaLimit: ep.quotaLimit,
      quotaSold: ep.quotaSold,
      displayOrder: ep.displayOrder
    }));
  }

  async removeEventProduct(eventId: number, variantId: number) {
    await this.prisma.eventProduct.delete({
      where: {
        eventId_productVariantId: {
          eventId: BigInt(eventId),
          productVariantId: BigInt(variantId)
        }
      }
    });
    return { message: 'Produk berhasil dihapus dari event' };
  }
}