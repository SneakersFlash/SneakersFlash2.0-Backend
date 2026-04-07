import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto'; // Nanti kita buat DTO-nya
import { UpdateEventDto } from './dto/update-event.dto';
import { google } from 'googleapis';
import slugify from 'slugify';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

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
    const regex = /\/d\/([a-zA-Z0-9-_]+)/;
    const match = sheetUrl.match(regex);
    if (!match) {
      throw new BadRequestException('Format URL Google Sheet tidak valid.');
    }
    const spreadsheetId = match[1];

    // 3. Setup Auth Google Sheets
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const range = `${sheetName}!A1:Z2000`; 
    
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

      // 5. Mapping Header (Pastikan huruf kecil semua agar aman)
      const headers = rows[0].map((h) => h.toLowerCase().trim());
      
      if (!headers.includes('sku')) {
        throw new BadRequestException('Sheet harus memiliki kolom "sku".');
      }

      const getValue = (row: any[], colNames: string[]) => {
        for (const colName of colNames) {
          const index = headers.indexOf(colName.toLowerCase());
          if (index !== -1 && row[index]) return row[index].toString().trim();
        }
        return null;
      };

      const dataRows = rows.slice(1);
      let successCount = 0;
      let newlyCreatedCount = 0;

      // 6. Looping Data dan Upsert ke Database
      for (const row of dataRows) {
        // === MAPPING BERDASARKAN FORMAT KOLOM ANDA ===
        const sku = getValue(row, ['sku']);
        if (!sku) continue;

        const parsePriceString = (valStr: string | null) => {
          if (!valStr) return 0;
          let cleanStr = valStr.toString().toLowerCase();
          
          cleanStr = cleanStr.replace(/(rp|idr|\s)/g, '');
          
          cleanStr = cleanStr.replace(/\./g, '');
          
          cleanStr = cleanStr.replace(/,/g, '.');
          
          return parseFloat(cleanStr) || 0;
        };

        const rawSpecialPrice = getValue(row, ['sale_price', 'special_price', 'harga_promo']);
        const specialPrice = parsePriceString(rawSpecialPrice);

        const quotaLimit = 0; 
        const displayOrder = 0;

        // Cari Variant berdasarkan SKU
        let variant = await this.prisma.productVariant.findUnique({
          where: { sku: sku }
        });

        // ==========================================
        // JIKA SKU TIDAK DITEMUKAN, BUAT PRODUK BARU
        // ==========================================
        if (!variant) {
          const productName = getValue(row, ['name']) || `Produk Baru - ${sku}`;
          
          const rawNormalPrice = getValue(row, ['price', 'normal_price', 'harga_normal']);
          const normalPrice = parsePriceString(rawNormalPrice) || specialPrice;
          
          const stockQuantity = parseInt(getValue(row, ['stock_quantity']) || '0', 10);
          const weight = parseFloat(getValue(row, ['weight']) || '1000');
          const description = getValue(row, ['description']) || '';
          const skuParent = getValue(row, ['sku_parent']);

          // Tarik semua gambar dari images_1 s/d images_5
          const images: string[] = [];
          ['images_1', 'images_2', 'images_3', 'images_4', 'images_5'].forEach(imgCol => {
            const img = getValue(row, [imgCol]);
            if (img) images.push(img);
          });
          
          // Cek Product Parent
          let product = await this.prisma.product.findFirst({
            where: { name: productName }
          });

          // Buat Product Parent jika belum ada
          if (!product) {
             const slug = slugify(productName, { lower: true, strict: true }) + '-' + Math.floor(Math.random() * 1000);
            product = await this.prisma.product.create({
                data: {
                  name: productName,
                  slug: slug,
                  description: description,
                  basePrice: normalPrice,
                  weightGrams: weight,
                  skuParent: skuParent,
                  isActive: true
                }
            });
          }

          // Buat variant (SKU)
          variant = await this.prisma.productVariant.create({
              data: {
                productId: product.id,
                sku: sku,
                price: normalPrice,
                stockQuantity: stockQuantity,
                imageUrl: images, // <-- Gambar otomatis masuk!
                isActive: true
              }
          });

          newlyCreatedCount++;
          this.logger.log(`Created new Product/Variant for SKU: ${sku}`);
        }

        // ==========================================
        // UPSERT KE TABEL EVENT PRODUCT
        // ==========================================
        await this.prisma.eventProduct.upsert({
          where: {
            eventId_productVariantId: {
              eventId: eventIdBigInt,
              productVariantId: variant.id
            }
          },
          update: {
            // Jika specialPrice 0 (tidak ada diskon), kita simpan sebagai null agar pakai harga normal
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

      // Format pesan akhir
      let finalMessage = `Berhasil sinkronisasi ${successCount} produk ke event ${event.title}.`;
      if (newlyCreatedCount > 0) {
        finalMessage += ` (Termasuk membuat ${newlyCreatedCount} varian baru otomatis).`;
      }

      return { 
        status: 'success', 
        message: finalMessage,
      };

    } catch (error: any) {
      this.logger.error('Google Sheet Sync Error:', error);
      if (error.code === 403) {
        throw new BadRequestException('Akses ditolak oleh Google. Pastikan file Spreadsheet sudah di-share (Viewer) ke email Service Account Anda.');
      }
      throw new BadRequestException(`Gagal membaca sheet: ${error.message}`);
    }
  }

  async findEventProductsAdmin(eventId: number, query: any = {}) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'displayOrder', 
      sortOrder = 'asc'
    } = query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where: any = {
      eventId: BigInt(eventId),
    };

    if (search) {
      where.variant = {
        OR: [
          { sku: { contains: search, mode: 'insensitive' } },
          { product: { name: { contains: search, mode: 'insensitive' } } }
        ]
      };
    }

    let orderBy: any = {};
    if (sortBy === 'sku') {
      orderBy = { variant: { sku: sortOrder } };
    } else if (sortBy === 'productName') {
      orderBy = { variant: { product: { name: sortOrder } } };
    } else if (sortBy === 'specialPrice') {
      orderBy = { specialPrice: sortOrder };
    } else if (sortBy === 'quotaSold') {
      orderBy = { quotaSold: sortOrder };
    } else {
      orderBy = { displayOrder: sortOrder };
    }

    const [rawProducts, total] = await this.prisma.$transaction([
      this.prisma.eventProduct.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          variant: {
            include: {
              product: true
            }
          }
        }
      }),
      this.prisma.eventProduct.count({ where })
    ]);

    const formattedData = rawProducts.map(ep => ({
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

    return {
      data: formattedData,
      meta: {
        total,
        page: Number(page),
        limit: Number(limit),
        lastPage: Math.ceil(total / take),
        hasNextPage: Number(page) < Math.ceil(total / take),
        hasPrevPage: Number(page) > 1,
      }
    };
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