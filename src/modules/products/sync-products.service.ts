import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { google } from 'googleapis';
import slugify from 'slugify';

@Injectable()
export class SyncProductsService {
  private readonly logger = new Logger(SyncProductsService.name);

  constructor(private prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // BUG FIX #1: Smart Price Parser
  //
  // parseFloat() RUSAK untuk format angka Indonesia!
  //   "1.799.000" → parseFloat → 1.799  (SALAH, harusnya 1799000)
  //   "Rp 1.799.000" → parseFloat → NaN  (SALAH)
  //   "1,799,000" → parseFloat → 1  (SALAH)
  //
  // Fungsi ini menangani semua format yang mungkin muncul dari Google Sheet.
  // ─────────────────────────────────────────────────────────────────────────────
  private parsePrice(raw: string | null | undefined): number {
    if (!raw) return 0;

    // Hapus simbol mata uang, spasi, dan karakter tidak relevan
    let cleaned = raw.toString().trim().replace(/[Rp\s\u00A0]/gi, '');
    if (!cleaned) return 0;

    const dotCount   = (cleaned.match(/\./g) || []).length;
    const commaCount = (cleaned.match(/,/g) || []).length;

    if (dotCount > 1) {
      // "1.799.000" → titik = ribuan, tidak ada desimal → hapus semua titik
      cleaned = cleaned.replace(/\./g, '');
    } else if (commaCount > 1) {
      // "1,799,000" → koma = ribuan → hapus semua koma
      cleaned = cleaned.replace(/,/g, '');
    } else if (dotCount === 1 && commaCount === 1) {
      // Bisa "1.799,00" (European) atau "1,799.00" (US)
      const dotIdx   = cleaned.indexOf('.');
      const commaIdx = cleaned.indexOf(',');
      if (dotIdx < commaIdx) {
        // "1.799,00" → titik = ribuan, koma = desimal
        cleaned = cleaned.replace('.', '').replace(',', '.');
      } else {
        // "1,799.00" → koma = ribuan, titik = desimal
        cleaned = cleaned.replace(',', '');
      }
    } else if (commaCount === 1 && dotCount === 0) {
      const afterComma = cleaned.split(',')[1];
      if (afterComma && afterComma.length === 3) {
        // "1,799" → koma = ribuan (bukan desimal)
        cleaned = cleaned.replace(',', '');
      } else {
        // "1799,50" → koma = desimal
        cleaned = cleaned.replace(',', '.');
      }
    } else if (dotCount === 1 && commaCount === 0) {
      const afterDot = cleaned.split('.')[1];
      if (afterDot && afterDot.length === 3) {
        // "1.799" → titik = ribuan (bukan desimal)
        cleaned = cleaned.replace('.', '');
      }
      // "1799.50" → titik = desimal → biarkan
    }

    const result = parseFloat(cleaned);
    return isNaN(result) ? 0 : Math.round(result); // bulatkan ke rupiah penuh
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // BUG FIX #2: Smart Size Extractor dari SKU
  //
  // Kalau kolom "available_sizes" kosong di sheet, coba ekstrak otomatis dari SKU.
  // Contoh: sku = "31079708/41", skuParent = "31079708" → ukuran = "41"
  //         sku = "BGPS1439LB.XL", skuParent = "BGPS1439LB" → ukuran = "XL"
  // ─────────────────────────────────────────────────────────────────────────────
  private extractSizeFromSku(sku: string, skuParent: string): string | null {
    if (!sku || !skuParent) return null;
    for (const sep of ['/', '.', '-', '_']) {
      if (sku.startsWith(skuParent + sep)) {
        const size = sku.slice(skuParent.length + 1).trim();
        return size || null;
      }
    }
    // Fallback: jika sku dimulai dengan skuParent tapi tanpa separator
    if (sku.length > skuParent.length && sku.startsWith(skuParent)) {
      return sku.slice(skuParent.length).trim() || null;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MAIN SYNC
  // ─────────────────────────────────────────────────────────────────────────────
  async syncFromGoogleSheet() {
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const spreadsheetId = process.env.GOOGLE_PRODUCT_SPREADSHEET_ID;
    const sheetName     = process.env.GOOGLE_PRODUCT_SHEET_NAME || 'data_front';
    const rangeData     = process.env.GOOGLE_PRODUCT_RANGE || 'A1:AE5000';
    const range         = `${sheetName}!${rangeData}`;

    this.logger.log(`Starting sync from Sheet: ${sheetName}!${rangeData}`);

    try {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      const rows = response.data.values;

      if (!rows || rows.length < 2) {
        return { status: 'warning', message: 'No data found in spreadsheet range.' };
      }

      // ── Parse headers ──
      const headers = rows[0].map((h: any) =>
        h?.toString().toLowerCase().trim().replace(/\s+/g, '_') ?? '',
      );
      this.logger.log(`Detected ${headers.length} columns: ${headers.join(', ')}`);

      if (!headers.includes('sku_parent')) {
        throw new Error('Column "sku_parent" is required but not found in the sheet!');
      }

      // Helper ambil nilai dari row berdasarkan nama kolom
      const getValue = (row: any[], col: string): string | null => {
        const idx = headers.indexOf(col);
        if (idx === -1) return null;
        const val = row[idx];
        return val !== undefined && val !== null && val.toString().trim() !== ''
          ? val.toString().trim()
          : null;
      };

      // Filter baris kosong
      const dataRows = rows.slice(1).filter((row: any[]) =>
        row.some((cell) => cell?.toString().trim()),
      );

      // ── Grouping by SKU Parent ──
      const grouped = new Map<string, any[]>();
      let rowsWithoutParent = 0;
      for (const row of dataRows) {
        const skuParent = getValue(row, 'sku_parent');
        if (!skuParent) { rowsWithoutParent++; continue; }
        if (!grouped.has(skuParent)) grouped.set(skuParent, []);
        grouped.get(skuParent)!.push(row);
      }

      this.logger.log(
        `Grouped ${grouped.size} parent products. ${rowsWithoutParent} rows skipped (no sku_parent).`,
      );

      // ── Pre-fetch Option "Size" sekali saja ──
      const sizeOption = await this.findOrCreateOption('Size');

      // ── In-memory cache untuk brand & kategori agar tidak spam DB ──
      const brandCache    = new Map<string, any>();
      const categoryCache = new Map<string, any>();

      // ── BUG FIX #3: Loop per produk, terisolasi
      // Satu produk gagal tidak menghentikan yang lain ──
      const result = { synced: 0, failed: 0, errors: [] as string[] };

      for (const [skuParent, variantRows] of grouped) {
        try {
          await this.syncOneProduct({
            skuParent, variantRows, getValue, sizeOption, brandCache, categoryCache,
          });
          result.synced++;
        } catch (err: any) {
          result.failed++;
          const msg = `[${skuParent}] ${err?.message ?? 'Unknown error'}`;
          result.errors.push(msg);
          this.logger.error(msg, err?.stack);
        }
      }

      this.logger.log(`Sync done. Synced: ${result.synced}, Failed: ${result.failed}`);

      return {
        status: 'success',
        message: `Berhasil sync ${result.synced} produk. Gagal: ${result.failed}.`,
        ...(result.errors.length > 0 && { errors: result.errors.slice(0, 30) }),
      };

    } catch (error) {
      this.logger.error('Sync failed:', error);
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SYNC SATU PRODUK
  //
  // BUG FIX #4: Cari produk by skuParent DULU sebelum generate slug baru
  //             → slug tidak pernah berubah jika produk sudah ada di DB
  //
  // BUG FIX #5: Logika harga yang benar:
  //   - product.basePrice  = kolom "price" (harga asli/MRP, TIDAK BOLEH pakai sale_price)
  //   - variant.price      = sale_price jika valid (> 0 dan < basePrice), else basePrice
  //   - sale_price = 0 / kosong / >= basePrice → dianggap tidak ada diskon
  //
  //   Ini memastikan ProductCard menampilkan badge "Save X%" dengan benar,
  //   dan EventProduct.specialPrice tidak bentrok dengan harga variant.
  // ─────────────────────────────────────────────────────────────────────────────
  private async syncOneProduct({
    skuParent,
    variantRows,
    getValue,
    sizeOption,
    brandCache,
    categoryCache,
  }: {
    skuParent: string;
    variantRows: any[][];
    getValue: (row: any[], col: string) => string | null;
    sizeOption: any;
    brandCache: Map<string, any>;
    categoryCache: Map<string, any>;
  }) {
    const firstRow = variantRows[0];

    const productName =
      getValue(firstRow, 'product_name') ||
      getValue(firstRow, 'name') ||
      skuParent;

    const brandName      = getValue(firstRow, 'brand');
    const categoryRawStr = getValue(firstRow, 'product_type') || getValue(firstRow, 'category') || 'Uncategorized';
    const description    = getValue(firstRow, 'description') || '';
    const weightRaw      = getValue(firstRow, 'weight') || getValue(firstRow, 'weight_grams') || '1000';
    const weight         = parseInt(weightRaw) || 1000;
    const gineeProductId = getValue(firstRow, 'ginee_product_id') || getValue(firstRow, 'ginee_id');

    // basePrice SELALU dari kolom "price", bukan "sale_price"
    const basePriceRaw = getValue(firstRow, 'price') || getValue(firstRow, 'base_price');
    const basePrice    = this.parsePrice(basePriceRaw);

    if (basePrice <= 0) {
      throw new Error(
        `Harga tidak valid "${basePriceRaw}" untuk produk "${productName}". ` +
        `Pastikan kolom "price" diisi dengan angka yang benar (contoh: 1799000 atau 1.799.000).`,
      );
    }

    // Brand & Kategori dengan cache
    const brand      = brandName ? await this.getCachedBrand(brandName, brandCache) : null;
    const categories = await this.getCachedCategories(categoryRawStr, categoryCache);
    const categoryConnections = categories.map((c: any) => ({ id: c.id }));

    // BUG FIX #4: Cari by skuParent dulu untuk stabilitas slug
    const existingBySkuParent = await this.prisma.product.findFirst({ where: { skuParent } });
    let slug = existingBySkuParent?.slug
      ?? slugify(`${productName}-${skuParent}`, { lower: true, strict: true });

    const productData: any = {
      name:        productName,
      description,
      slug,
      basePrice,
      weightGrams: weight,
      brandId:     brand?.id ?? null,
      isActive:    true,
      skuParent,
      ...(gineeProductId && { gineeProductId, gineeSyncStatus: 'synced' }),
    };

    let product: any;
    if (existingBySkuParent) {
      product = await this.prisma.product.update({
        where: { id: existingBySkuParent.id },
        data:  { ...productData, categories: { set: categoryConnections } },
      });
    } else {
      // Double-safety: cek slug collision sebelum create
      const slugExists = await this.prisma.product.findUnique({ where: { slug } });
      if (slugExists) {
        productData.slug = `${slug}-${Date.now()}`;
      }
      product = await this.prisma.product.create({
        data: { ...productData, categories: { connect: categoryConnections } },
      });
    }

    // ── Loop Variant ──
    for (const row of variantRows) {
      const sku = getValue(row, 'sku');
      if (!sku) {
        this.logger.warn(`[${skuParent}] Baris dilewati: kolom "sku" kosong`);
        continue;
      }

      // BUG FIX #5: Price logic per variant
      const variantPriceRaw  = getValue(row, 'price') || getValue(row, 'base_price');
      const salePriceRaw     = getValue(row, 'sale_price') || getValue(row, 'special_price');

      const variantBasePrice = this.parsePrice(variantPriceRaw) || basePrice;
      const salePrice        = this.parsePrice(salePriceRaw);

      // sale_price valid = ada nilainya & lebih kecil dari harga asli
      const finalVariantPrice =
        salePrice > 0 && salePrice < variantBasePrice
          ? salePrice
          : variantBasePrice;

      const stock      = parseInt(getValue(row, 'stock_quantity') || getValue(row, 'stock') || '0') || 0;
      const gineeSkuId = getValue(row, 'ginee_sku_id') || getValue(row, 'ginee_variant_id');

      // Ambil gambar (support image_1 sampai image_8 atau images_1 sampai images_8)
      const images: string[] = [];
      for (let i = 1; i <= 8; i++) {
        const img = getValue(row, `image_${i}`) ?? getValue(row, `images_${i}`);
        if (img) images.push(img);
      }
      if (images.length === 0) {
        const imgUrl = getValue(row, 'image_url') ?? getValue(row, 'image');
        if (imgUrl) {
          const sep = imgUrl.includes(',') ? ',' : imgUrl.includes('\n') ? '\n' : null;
          if (sep) {
            imgUrl.split(sep).forEach((u: string) => { if (u.trim()) images.push(u.trim()); });
          } else if (imgUrl.trim()) {
            images.push(imgUrl.trim());
          }
        }
      }

      const variant = await this.prisma.productVariant.upsert({
        where:  { sku },
        update: {
          price:         finalVariantPrice,
          stockQuantity: stock,
          imageUrl:      images,
          isActive:      true,
          ...(gineeSkuId && { gineeSkuId }),
        },
        create: {
          productId:     product.id,
          sku,
          price:         finalVariantPrice,
          stockQuantity: stock,
          imageUrl:      images,
          isActive:      true,
          ...(gineeSkuId && { gineeSkuId }),
        },
      });

      // BUG FIX #2: Mapping ukuran — kolom sheet dulu, fallback ke ekstrak dari SKU
      const sizeValueStr =
        getValue(row, 'available_sizes') ||
        getValue(row, 'size') ||
        getValue(row, 'ukuran') ||
        this.extractSizeFromSku(sku, skuParent);

      if (sizeValueStr && sizeOption) {
        await this.linkSizeToVariant(variant.id, sizeOption.id, sizeValueStr);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  private async linkSizeToVariant(variantId: bigint, optionId: bigint, sizeValue: string) {
    const optionValue = await this.findOrCreateOptionValue(optionId, sizeValue);
    const exists = await this.prisma.variantOption.findUnique({
      where: { variantId_optionValueId: { variantId, optionValueId: optionValue.id } },
    });
    if (!exists) {
      await this.prisma.variantOption.create({ data: { variantId, optionValueId: optionValue.id } });
    }
  }

  private async getCachedBrand(name: string, cache: Map<string, any>) {
    const key = name.trim().toLowerCase();
    if (!cache.has(key)) cache.set(key, await this.findOrCreateBrand(name));
    return cache.get(key);
  }

    private async getCachedCategories(rawStr: string, cache: Map<string, any>) {
        const names = [...new Set(rawStr.split(',').map((c) => c.trim()).filter(Boolean))];
        if (names.length === 0) names.push('Uncategorized');
        
        // PERBAIKAN: Beri tahu TypeScript bahwa ini adalah array dari 'any' atau 'Category'
        const result: any[] = []; 

        for (const name of names) {
            const key = name.toLowerCase();
            if (!cache.has(key)) cache.set(key, await this.findOrCreateCategorySingle(name));
            result.push(cache.get(key));
        }
        return result;
    }

  private async findOrCreateBrand(name: string | null) {
    if (!name) return null;
    const cleanName = name.trim();
    let brand = await this.prisma.brand.findFirst({ where: { name: cleanName } });
    if (!brand) {
      const slug = slugify(cleanName, { lower: true, strict: true });
      brand = await this.prisma.brand.create({ data: { name: cleanName, slug } });
    }
    return brand;
  }

  private async findOrCreateCategorySingle(catName: string) {
    let category = await this.prisma.category.findFirst({ where: { name: catName } });
    if (!category) {
      const slug = slugify(catName, { lower: true, strict: true });
      const existingSlug = await this.prisma.category.findUnique({ where: { slug } });
      category = existingSlug ?? await this.prisma.category.create({ data: { name: catName, slug } });
    }
    return category;
  }

  async findOrCreateCategory(categoryRawStr: string) {
    const names = [...new Set(categoryRawStr.split(',').map((c) => c.trim()).filter(Boolean))];
    if (names.length === 0) names.push('Uncategorized');
    return Promise.all(names.map((n) => this.findOrCreateCategorySingle(n)));
  }

  private async findOrCreateOption(name: string) {
    let option = await this.prisma.option.findFirst({ where: { name } });
    if (!option) option = await this.prisma.option.create({ data: { name } });
    return option;
  }

  private async findOrCreateOptionValue(optionId: bigint, value: string) {
    let optValue = await this.prisma.optionValue.findFirst({ where: { optionId, value } });
    if (!optValue) optValue = await this.prisma.optionValue.create({ data: { optionId, value } });
    return optValue;
  }
}