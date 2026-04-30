import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { google } from 'googleapis';
import slugify from 'slugify';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(private prisma: PrismaService) {}

  // ===================================
  // ADMIN FEATURES
  // ===================================

  async create(dto: CreateEventDto) {
    const existing = await this.prisma.event.findUnique({ where: { slug: dto.slug } });
    if (existing) throw new BadRequestException('Slug event sudah digunakan!');

    return await this.prisma.event.create({
      data: {
        title:           dto.title,
        slug:            dto.slug,
        bannerDesktopUrl: dto.bannerDesktopUrl,
        bannerMobileUrl:  dto.bannerMobileUrl,
        contentHtml:     dto.contentHtml,
        styleConfig:     dto.styleConfig,
        startAt:         new Date(dto.startAt),
        endAt:           new Date(dto.endAt),
        isActive:        dto.isActive ?? true,
        isTimer:         dto.isTimer ?? true,
        sort:            dto.sort ?? 0,
        metaTitle:       dto.metaTitle,
        metaDescription: dto.metaDescription,
        ogImageUrl:      dto.ogImageUrl,
      },
    });
  }

  async findAllAdmin() {
    const events = await this.prisma.event.findMany({
      orderBy: { id: 'desc' },
      include: {
        _count: { select: { eventProducts: true } },
      },
    });
    return events.map((e) => ({ ...e, id: e.id.toString() }));
  }

  async update(id: number, dto: UpdateEventDto) {
    const eventId = BigInt(id);
    const event   = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Event tidak ditemukan!');

    if (dto.slug && dto.slug !== event.slug) {
      const existing = await this.prisma.event.findUnique({ where: { slug: dto.slug } });
      if (existing) throw new BadRequestException('Slug event sudah digunakan!');
    }

    const updated = await this.prisma.event.update({
      where: { id: eventId },
      data: {
        title:           dto.title,
        slug:            dto.slug,
        bannerDesktopUrl: dto.bannerDesktopUrl,
        bannerMobileUrl:  dto.bannerMobileUrl,
        contentHtml:     dto.contentHtml,
        styleConfig:     dto.styleConfig,
        startAt:         dto.startAt ? new Date(dto.startAt) : undefined,
        endAt:           dto.endAt   ? new Date(dto.endAt)   : undefined,
        isActive:        dto.isActive,
        isTimer:         dto.isTimer ?? true,
        sort:            dto.sort ?? 0,
        metaTitle:       dto.metaTitle,
        metaDescription: dto.metaDescription,
        ogImageUrl:      dto.ogImageUrl,
      },
    });
    return { ...updated, id: updated.id.toString() };
  }

  async remove(id: number) {
    const eventId = BigInt(id);
    const event   = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Event tidak ditemukan!');

    await this.prisma.$transaction([
      this.prisma.eventProduct.deleteMany({ where: { eventId } }),
      this.prisma.event.delete({ where: { id: eventId } }),
    ]);

    return { message: 'Event beserta produk di dalamnya berhasil dihapus' };
  }

  async addProductToEvent(
    eventId: number,
    productId: number,
    specialPrice: number,
    quota: number,
  ) {
    const exists = await this.prisma.eventProduct.findUnique({
      where: {
        eventId_productId: {
          eventId:   BigInt(eventId),
          productId: BigInt(productId),
        },
      },
    });
    if (exists) throw new BadRequestException('Produk sudah ada di event ini.');

    return await this.prisma.eventProduct.create({
      data: {
        eventId:      BigInt(eventId),
        productId:    BigInt(productId),
        specialPrice,
        quotaLimit:   quota,
        quotaSold:    0,
        displayOrder: 0,
      },
    });
  }

  // ===================================
  // PUBLIC / STOREFRONT FEATURES
  // ===================================

  async findBySlug(slug: string, query: any = {}) {
    const { page = 1, limit = 16 } = query;
    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);
    const now  = new Date();

    const event = await this.prisma.event.findUnique({ where: { slug } });
    if (!event) throw new NotFoundException('Event tidak ditemukan');

    const [rawProducts, totalProducts] = await this.prisma.$transaction([
      this.prisma.eventProduct.findMany({
        where:   { eventId: event.id },
        orderBy: { displayOrder: 'asc' },
        skip,
        take,
        include: {
          product: {
            include: { brand: true, variants: true },
          },
        },
      }),
      this.prisma.eventProduct.count({ where: { eventId: event.id } }),
    ]);

    return {
      id:              event.id.toString(),
      title:           event.title,
      slug:            event.slug,
      contentHtml:     event.contentHtml,
      bannerDesktopUrl: event.bannerDesktopUrl,
      bannerMobileUrl:  event.bannerMobileUrl,
      styleConfig:     event.styleConfig,
      countDownEnd:    event.endAt,
      isActive:        event.isActive && event.startAt <= now && event.endAt >= now,
      isTimer:         event.isTimer,
      sort:            event.sort,

      products: rawProducts.map((ep) => {
        const basePrice      = Number(ep.product.basePrice);
        const promoPrice     = ep.specialPrice ? Number(ep.specialPrice) : basePrice;
        const discountPercent = Math.round(((basePrice - promoPrice) / basePrice) * 100);
        const isSoldOut      = ep.quotaLimit > 0 && ep.quotaSold >= ep.quotaLimit;
        const firstVariant   = ep.product.variants[0];

        return {
          productVariantId: firstVariant ? firstVariant.id.toString() : '0',
          productId:        ep.productId.toString(),
          name:             ep.product.name,
          brand:            ep.product.brand?.name || 'Brand',
          slug:             ep.product.slug,
          image:            firstVariant?.imageUrl?.[0] || null,
          originalPrice:    basePrice,
          finalPrice:       promoPrice,
          discountPercent:  discountPercent > 0 ? discountPercent : null,
          isFlashSale:      !!ep.specialPrice,
          isSoldOut,
          stockBar: ep.quotaLimit > 0
            ? { total: ep.quotaLimit, sold: ep.quotaSold }
            : null,
        };
      }),

      meta: {
        total:    totalProducts,
        page:     Number(page),
        limit:    Number(limit),
        lastPage: Math.ceil(totalProducts / take),
      },
    };
  }

  async findActiveEvents() {
    const now = new Date();

    const events = await this.prisma.event.findMany({
      where: {
        isActive: true,
        startAt:  { lte: now },
        endAt:    { gte: now },
      },
      orderBy: { sort: 'asc' },
      include: {
        eventProducts: {
          take:    15,
          orderBy: { displayOrder: 'asc' },
          include: {
            product: {
              include: { brand: true, variants: true },
            },
          },
        },
      },
    });

    return events.map((event) => ({
      id:              event.id.toString(),
      title:           event.title,
      slug:            event.slug,
      bannerDesktopUrl: event.bannerDesktopUrl,
      bannerMobileUrl:  event.bannerMobileUrl,
      styleConfig:     event.styleConfig,
      countDownEnd:    event.endAt,
      isTimer:         event.isTimer,
      sort:            event.sort,

      products: event.eventProducts.map((ep) => {
        const basePrice       = Number(ep.product.basePrice);
        const promoPrice      = ep.specialPrice ? Number(ep.specialPrice) : basePrice;
        const discountPercent = Math.round(((basePrice - promoPrice) / basePrice) * 100);
        const isSoldOut       = ep.quotaLimit > 0 && ep.quotaSold >= ep.quotaLimit;
        const firstVariant    = ep.product.variants[0];

        return {
          productVariantId: firstVariant
            ? firstVariant.id.toString()
            : ep.productId.toString(),
          productId:       ep.productId.toString(),
          name:            ep.product.name,
          brand:           ep.product.brand?.name || 'Brand',
          slug:            ep.product.slug,
          image:           firstVariant?.imageUrl?.[0] || null,
          images:          firstVariant?.imageUrl || [],
          originalPrice:   basePrice,
          finalPrice:      promoPrice,
          discountPercent: discountPercent > 0 ? discountPercent : null,
          isFlashSale:     !!ep.specialPrice,
          isSoldOut,
          stockBar: ep.quotaLimit > 0
            ? { total: ep.quotaLimit, sold: ep.quotaSold }
            : null,
        };
      }),
    }));
  }

  // ===================================
  // SYNC EVENT PRODUCTS FROM GOOGLE SHEET
  //
  // FIX #1  — Gunakan UNFORMATTED_VALUE agar harga masuk sebagai angka mentah
  // FIX #2  — Range diperlebar ke AZ5000 agar kolom tidak terpotong
  // FIX #3  — Identitas produk event pakai skuParent ber-prefix, BUKAN sku Shopee
  //            → menghindari SKU collision antar sheet
  // FIX #4  — Produk event selalu dibuat terpisah dari katalog utama (data_front)
  //            sehingga produk asli tetap tampil dengan harga normal
  // FIX #5  — SKU variant event = "{PREFIX}-{sku_asli}" sebagai penanda
  // FIX #6  — Lookup idempotent: cek by eventSku, bukan by sku global
  // FIX #7  — Variable scoping bug dihapus (tidak ada lagi redeclare product/productName)
  // FIX #8  — Stock variant diupdate jika SKU event sudah ada
  // FIX #9  — Image URL "0" difilter, hanya URL valid (startsWith http) yang masuk
  // FIX #10 — parsePrice dari sync-products digunakan, bukan parsePriceString lokal
  // ===================================
  async syncEventProductsFromSheet(
    eventId:   number,
    sheetUrl:  string,
    sheetName: string,
    skuPrefix: string = 'EVT',
  ) {
    const eventIdBigInt = BigInt(eventId);

    const event = await this.prisma.event.findUnique({ where: { id: eventIdBigInt } });
    if (!event) throw new NotFoundException('Event tidak ditemukan!');

    // Sanitize prefix: hanya huruf & angka, max 10 karakter
    const prefix = skuPrefix.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    if (!prefix) throw new BadRequestException('skuPrefix tidak valid.');

    // Ekstrak spreadsheet ID dari URL Google Sheet
    const regex = /\/d\/([a-zA-Z0-9-_]+)/;
    const match = sheetUrl.match(regex);
    if (!match) throw new BadRequestException('Format URL Google Sheet tidak valid.');
    const spreadsheetId = match[1];

    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes:  ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // FIX #2: range diperlebar
    const range = `${sheetName}!A1:AZ5000`;

    this.logger.log(
      `Syncing Event "${event.title}" | prefix: ${prefix} | Sheet: ${spreadsheetId} | Range: ${range}`,
    );

    try {
      // FIX #1: UNFORMATTED_VALUE → angka masuk sebagai number, bukan string berformat
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
        valueRenderOption: 'UNFORMATTED_VALUE',
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        throw new BadRequestException('Tidak ada data di spreadsheet.');
      }

      // Normalisasi header
      const headers = rows[0].map((h: any) =>
        h?.toString().toLowerCase().trim().replace(/\s+/g, '_') ?? '',
      );

      if (!headers.includes('sku_parent')) {
        throw new BadRequestException('Sheet harus memiliki kolom "sku_parent".');
      }

      // ── getValue — handle angka, string, scientific notation ──────────────
      const getValue = (row: any[], col: string): string | null => {
        const idx = headers.indexOf(col.toLowerCase());
        if (idx === -1) return null;
        const val = row[idx];
        if (val === undefined || val === null || val.toString().trim() === '') return null;
        // FIX: angka besar (Shopee ID) bisa scientific notation di JS
        if (typeof val === 'number') {
          return Number.isInteger(val) ? val.toFixed(0) : val.toString();
        }
        return val.toString().trim();
      };

      const dataRows = rows
        .slice(1)
        .filter((row: any[]) => row.some((cell) => cell?.toString().trim()));

      const sizeOption = await this.findOrCreateOption('Size');
      const brandCache = new Map<string, any>(); // cache brand agar tidak spam DB

      let successCount = 0;
      let createdCount = 0;
      let skippedCount = 0;
      const errors: string[] = [];

      for (const row of dataRows) {
        const skuParent = getValue(row, 'sku_parent');
        const sku       = getValue(row, 'sku');

        if (!skuParent || !sku) {
          this.logger.warn('Baris dilewati: sku_parent atau sku kosong');
          skippedCount++;
          continue;
        }

        try {
          const isNew = await this.syncOneEventProduct({
            eventIdBigInt,
            skuParent,
            sku,
            prefix,
            row,
            getValue,
            sizeOption,
            brandCache,
          });
          if (isNew) createdCount++;
          successCount++;
        } catch (err: any) {
          const msg = `[${prefix}-${skuParent}] ${err?.message ?? 'Unknown error'}`;
          errors.push(msg);
          this.logger.error(msg, err?.stack);
        }
      }

      let message =
        `Berhasil sync ${successCount} produk ke event "${event.title}" (prefix: ${prefix}).`;
      if (createdCount > 0) message += ` ${createdCount} produk event baru dibuat.`;
      if (skippedCount > 0) message += ` ${skippedCount} baris dilewati.`;

      return {
        status:  errors.length > 0 ? 'partial' : 'success',
        message,
        ...(errors.length > 0 && { errors: errors.slice(0, 30) }),
      };

    } catch (error: any) {
      this.logger.error('Google Sheet Event Sync Error:', error);
      if (error.code === 403) {
        throw new BadRequestException(
          'Akses ditolak. Pastikan Spreadsheet sudah di-share ke Service Account.',
        );
      }
      throw new BadRequestException(`Gagal membaca sheet: ${error.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SYNC SATU PRODUK EVENT
  //
  // Strategi (FIX #3–#10):
  //
  //   Produk data_front  : skuParent = "U9060GRY",   sku = "196307583015"   ← tidak disentuh
  //   Produk event "LC"  : skuParent = "LC-U9060GRY", sku = "LC-196307583015" ← produk terpisah
  //
  // Lookup idempotent by eventSku ("LC-196307583015"):
  //   - Ada  → produk event sudah pernah dibuat → update stok & eventProduct saja
  //   - Tidak → buat produk event baru + variant baru
  //
  // Returns: true jika produk baru dibuat, false jika update
  // ─────────────────────────────────────────────────────────────────────────────
  private async syncOneEventProduct({
    eventIdBigInt,
    skuParent,
    sku,
    prefix,
    row,
    getValue,
    sizeOption,
    brandCache,
  }: {
    eventIdBigInt: bigint;
    skuParent:     string;
    sku:           string;
    prefix:        string;
    row:           any[];
    getValue:      (row: any[], col: string) => string | null;
    sizeOption:    any;
    brandCache:    Map<string, any>;
  }): Promise<boolean> {
    // FIX #5: identifier unik untuk produk & variant event
    const eventSkuParent = `${prefix}-${skuParent}`; // "LC-U9060GRY"
    const eventSku       = `${prefix}-${sku}`;        // "LC-196307583015"

    const productName  = getValue(row, 'name') || `Produk - ${eventSkuParent}`;
    const description  = getValue(row, 'description') || '';
    const weight       = parseInt(getValue(row, 'weight') || '1000') || 1000;
    const brandName    = getValue(row, 'brand');
    const stock        = parseInt(getValue(row, 'stock_quantity') || getValue(row, 'stock') || '0') || 0;
    const displayOrder = parseInt(getValue(row, 'display_order') || '0') || 0;

    // FIX #10: gunakan parsePrice yang sama dengan sync-products (sudah handle UNFORMATTED_VALUE)
    const normalPrice  = this.parsePrice(getValue(row, 'price') || getValue(row, 'normal_price'));
    const specialPrice = this.parsePrice(
      getValue(row, 'sale_price') ||
      getValue(row, 'special_price') ||
      getValue(row, 'harga_promo'),
    );

    // FIX #9: hanya masukkan URL yang valid — filter "0" dan string kosong
    const images: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const img = getValue(row, `images_${i}`) ?? getValue(row, `image_${i}`);
      if (img && img.startsWith('http')) images.push(img);
    }

    // ──────────────────────────────────────────────────────────────
    // STEP 1: Cek apakah event variant sudah pernah dibuat
    //         (lookup idempotent by eventSku — FIX #6)
    // ──────────────────────────────────────────────────────────────
    const existingVariant = await this.prisma.productVariant.findUnique({
      where:   { sku: eventSku },
      include: { product: true },
    });

    let product: any;
    let variant: any;
    let isNewProduct = false;

    if (existingVariant) {
      // ── Sudah pernah di-sync → mirror semua data dari sheet ──
      product = existingVariant.product;

      // Mirror basePrice jika normalPrice valid di sheet
      const newBasePrice = normalPrice > 0 ? normalPrice : Number(product.basePrice);
      if (newBasePrice !== Number(product.basePrice)) {
        product = await this.prisma.product.update({
          where: { id: product.id },
          data:  { basePrice: newBasePrice },
        });
      }

      // Mirror price & stock (bukan hanya stock)
      const variantPrice = normalPrice > 0
        ? normalPrice
        : (specialPrice > 0 ? specialPrice : Number(existingVariant.price));
      variant = await this.prisma.productVariant.update({
        where: { id: existingVariant.id },
        data: {
          price:         variantPrice,
          stockQuantity: stock,
          ...(images.length > 0 && { imageUrl: images }),
        },
      });
      this.logger.log(`Updated event variant: ${eventSku}`);

    } else {
      // ── Belum ada → buat produk event baru ──────────────────────

      // Brand (dengan cache agar tidak spam DB)
      let brandId: bigint | null = null;
      if (brandName) {
        const key = brandName.trim().toLowerCase();
        if (!brandCache.has(key)) {
          let brand = await this.prisma.brand.findFirst({ where: { name: brandName.trim() } });
          if (!brand) {
            brand = await this.prisma.brand.create({
              data: {
                name: brandName.trim(),
                slug: slugify(brandName.trim(), { lower: true, strict: true }),
              },
            });
          }
          brandCache.set(key, brand);
        }
        brandId = brandCache.get(key).id;
      }

      // Produk event mungkin sudah ada tapi variant-nya dihapus manual
      // → cek by eventSkuParent sebagai safety net
      product = await this.prisma.product.findFirst({
        where: { skuParent: eventSkuParent },
      });

      if (product) {
        // Mirror basePrice jika normalPrice valid di sheet
        const newBasePrice = normalPrice > 0 ? normalPrice : Number(product.basePrice);
        if (newBasePrice !== Number(product.basePrice)) {
          product = await this.prisma.product.update({
            where: { id: product.id },
            data:  { basePrice: newBasePrice },
          });
        }
      }

      if (!product) {
        // FIX #4: produk event selalu terpisah dari data_front
        const baseSlug   = slugify(`${productName}-${eventSkuParent}`, { lower: true, strict: true });
        const slugExists = await this.prisma.product.findUnique({ where: { slug: baseSlug } });
        const finalSlug  = slugExists ? `${baseSlug}-${Date.now()}` : baseSlug;

        const basePrice  = normalPrice > 0 ? normalPrice : (specialPrice > 0 ? specialPrice : 1);

        product = await this.prisma.product.create({
          data: {
            name:        productName,
            slug:        finalSlug,
            description,
            basePrice,
            weightGrams: weight,
            skuParent:   eventSkuParent, // "LC-U9060GRY"
            brandId,
            isActive:    true,
          },
        });

        isNewProduct = true;
        this.logger.log(
          `Created event product: "${productName}" | skuParent: ${eventSkuParent}`,
        );
      }

      // FIX #5: variant SKU diberi prefix sebagai penanda barang event
      variant = await this.prisma.productVariant.create({
        data: {
          productId:     product.id,
          sku:           eventSku, // "LC-196307583015"
          price:         normalPrice > 0 ? normalPrice : (specialPrice > 0 ? specialPrice : 1),
          stockQuantity: stock,
          imageUrl:      images,
          isActive:      true,
        },
      });

      this.logger.log(`Created event variant: ${eventSku}`);
    }

    // ──────────────────────────────────────────────────────────────
    // STEP 2: Link Size ke Variant
    // ──────────────────────────────────────────────────────────────
    const sizeValueStr =
      getValue(row, 'available_sizes') ||
      getValue(row, 'size')            ||
      getValue(row, 'ukuran')          ||
      this.extractSizeFromSku(sku, skuParent); // pakai sku asli untuk ekstrak ukuran

    if (sizeValueStr && sizeValueStr !== 'NO SIZE' && sizeOption) {
      await this.linkSizeToVariant(variant.id, sizeOption.id, sizeValueStr);
    }

    // ──────────────────────────────────────────────────────────────
    // STEP 3: Upsert EventProduct
    //
    // quotaLimit = total stockQuantity semua variant produk event ini.
    // Produk dengan banyak ukuran (size) akan memiliki quota = jumlah stok semua size,
    // bukan hanya stok 1 variant terakhir yang diproses.
    //
    // specialPrice valid hanya jika ada nilai & lebih kecil dari basePrice produk event
    // ──────────────────────────────────────────────────────────────
    const stockAgg = await this.prisma.productVariant.aggregate({
      where: { productId: product.id },
      _sum:  { stockQuantity: true },
    });
    const totalQuota = stockAgg._sum.stockQuantity ?? stock;

    const basePrice         = Number(product.basePrice);
    const finalSpecialPrice =
      specialPrice > 0 && specialPrice < basePrice ? specialPrice : null;

    await this.prisma.eventProduct.upsert({
      where: {
        eventId_productId: {
          eventId:   eventIdBigInt,
          productId: product.id,
        },
      },
      update: {
        specialPrice:  finalSpecialPrice,
        quotaLimit:    totalQuota,
        displayOrder,
      },
      create: {
        eventId:       eventIdBigInt,
        productId:     product.id,
        specialPrice:  finalSpecialPrice,
        quotaLimit:    totalQuota,
        quotaSold:     0,
        displayOrder,
      },
    });

    return isNewProduct;
  }

  // ===================================
  // ADMIN — List Event Products
  // ===================================

  async findEventProductsAdmin(eventId: number, query: any = {}) {
    const {
      page      = 1,
      limit     = 10,
      search,
      sortBy    = 'displayOrder',
      sortOrder = 'asc',
    } = query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const where: any = { eventId: BigInt(eventId) };

    if (search) {
      where.product = {
        OR: [
          { skuParent: { contains: search, mode: 'insensitive' } },
          { name:      { contains: search, mode: 'insensitive' } },
        ],
      };
    }

    let orderBy: any = {};
    if (sortBy === 'sku')          orderBy = { product: { skuParent: sortOrder } };
    else if (sortBy === 'productName')  orderBy = { product: { name: sortOrder } };
    else if (sortBy === 'specialPrice') orderBy = { specialPrice: sortOrder };
    else if (sortBy === 'quotaSold')    orderBy = { quotaSold: sortOrder };
    else                                orderBy = { displayOrder: sortOrder };

    const [rawProducts, total] = await this.prisma.$transaction([
      this.prisma.eventProduct.findMany({
        where,
        skip,
        take,
        orderBy,
        include: { product: true },
      }),
      this.prisma.eventProduct.count({ where }),
    ]);

    const formattedData = rawProducts.map((ep) => ({
      eventId:       ep.eventId.toString(),
      productId:     ep.productId.toString(),
      sku:           ep.product.skuParent || '-',
      productName:   ep.product.name,
      originalPrice: Number(ep.product.basePrice),
      specialPrice:  ep.specialPrice ? Number(ep.specialPrice) : null,
      quotaLimit:    ep.quotaLimit,
      quotaSold:     ep.quotaSold,
      displayOrder:  ep.displayOrder,
    }));

    return {
      data: formattedData,
      meta: {
        total,
        page:        Number(page),
        limit:       Number(limit),
        lastPage:    Math.ceil(total / take),
        hasNextPage: Number(page) < Math.ceil(total / take),
        hasPrevPage: Number(page) > 1,
      },
    };
  }

  async removeEventProduct(eventId: number, productId: number) {
    if (
      !eventId || !productId ||
      isNaN(Number(eventId)) || isNaN(Number(productId))
    ) {
      throw new BadRequestException('eventId dan productId harus berupa angka yang valid.');
    }

    await this.prisma.eventProduct.delete({
      where: {
        eventId_productId: {
          eventId:   BigInt(eventId),
          productId: BigInt(productId),
        },
      },
    });

    return { message: 'Produk berhasil dihapus dari event' };
  }

  // ===================================
  // PRIVATE HELPERS
  // ===================================

  // ── parsePrice ───────────────────────────────────────────────────────────────
  // Sama dengan sync-products_service: menangani UNFORMATTED_VALUE (number)
  // maupun string berformat Indonesia (Rp 1.799.000, dll).
  // ─────────────────────────────────────────────────────────────────────────────
  private parsePrice(raw: string | number | null | undefined): number {
    if (raw === null || raw === undefined || raw === '') return 0;

    if (typeof raw === 'number') {
      return isNaN(raw) ? 0 : Math.round(raw);
    }

    let cleaned = raw
      .toString()
      .trim()
      .replace(/^(Rp\.?|IDR|USD|\$)\s*/i, '')
      .replace(/\s/g, '')
      .replace(/\u00A0/g, '');

    if (!cleaned) return 0;

    const dotCount   = (cleaned.match(/\./g)  || []).length;
    const commaCount = (cleaned.match(/,/g)   || []).length;

    if (dotCount > 1 && commaCount === 0) {
      cleaned = cleaned.replace(/\./g, '');
    } else if (commaCount > 1 && dotCount === 0) {
      cleaned = cleaned.replace(/,/g, '');
    } else if (dotCount > 1 && commaCount === 1) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else if (commaCount > 1 && dotCount === 1) {
      cleaned = cleaned.replace(/,/g, '');
    } else if (dotCount === 1 && commaCount === 1) {
      const dotIdx   = cleaned.indexOf('.');
      const commaIdx = cleaned.indexOf(',');
      if (dotIdx < commaIdx) {
        cleaned = cleaned.replace('.', '').replace(',', '.');
      } else {
        cleaned = cleaned.replace(',', '');
      }
    } else if (commaCount === 1 && dotCount === 0) {
      const afterComma = cleaned.split(',')[1] ?? '';
      cleaned = afterComma.length === 3
        ? cleaned.replace(',', '')
        : cleaned.replace(',', '.');
    } else if (dotCount === 1 && commaCount === 0) {
      const afterDot = cleaned.split('.')[1] ?? '';
      if (afterDot.length === 3) cleaned = cleaned.replace('.', '');
    }

    const result = parseFloat(cleaned);
    if (isNaN(result)) {
      this.logger.warn(`parsePrice: tidak bisa parse "${raw}" → cleaned = "${cleaned}"`);
      return 0;
    }
    return Math.round(result);
  }

  private extractSizeFromSku(sku: string, skuParent: string): string | null {
    if (!sku || !skuParent) return null;
    for (const sep of ['/', '.', '-', '_']) {
      if (sku.startsWith(skuParent + sep)) {
        return sku.slice(skuParent.length + 1).trim() || null;
      }
    }
    if (sku.length > skuParent.length && sku.startsWith(skuParent)) {
      return sku.slice(skuParent.length).trim() || null;
    }
    return null;
  }

  private async findOrCreateOption(name: string) {
    let option = await this.prisma.option.findFirst({ where: { name } });
    if (!option) option = await this.prisma.option.create({ data: { name } });
    return option;
  }

  private async findOrCreateOptionValue(optionId: bigint, value: string) {
    let optValue = await this.prisma.optionValue.findFirst({ where: { optionId, value } });
    if (!optValue) {
      optValue = await this.prisma.optionValue.create({ data: { optionId, value } });
    }
    return optValue;
  }

  private async linkSizeToVariant(
    variantId:   bigint,
    optionId:    bigint,
    sizeValue:   string,
  ) {
    const optionValue = await this.findOrCreateOptionValue(optionId, sizeValue);
    const exists = await this.prisma.variantOption.findUnique({
      where: {
        variantId_optionValueId: { variantId, optionValueId: optionValue.id },
      },
    });
    if (!exists) {
      await this.prisma.variantOption.create({
        data: { variantId, optionValueId: optionValue.id },
      });
    }
  }

  private serializeEvent(event: any) {
    if (!event) return null;
    return {
      ...event,
      id: event.id.toString(),
      eventProducts: event.eventProducts
        ? event.eventProducts.map((ep: any) => ({
            ...ep,
            eventId:      ep.eventId.toString(),
            productId:    ep.productId.toString(),
            specialPrice: ep.specialPrice ? Number(ep.specialPrice) : null,
          }))
        : undefined,
    };
  }
}