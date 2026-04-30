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
  // ─────────────────────────────────────────────────────────────────────────────
  // parsePrice — FIXED
  //
  // Dengan UNFORMATTED_VALUE, Google Sheets mengirim angka mentah (number/string).
  // Fungsi ini tetap dipertahankan sebagai safety-net untuk:
  //   • Kolom yang memang bertipe teks di sheet (misal: "Rp 1.799.000")
  //   • Impor dari sumber lain yang formatnya tidak konsisten
  //
  // Urutan penanganan:
  //   1. Jika sudah number → langsung kembalikan
  //   2. Hapus prefix mata uang (Rp, IDR, $, dll) dan spasi
  //   3. Deteksi separator ribuan vs desimal berdasarkan posisi & panjang
  //   4. Strip separator ribuan, normalkan desimal ke titik, lalu parseFloat
  //   5. Bulatkan ke bilangan bulat (rupiah tidak pakai sen)
  // ─────────────────────────────────────────────────────────────────────────────
  private parsePrice(raw: string | number | null | undefined): number {
    if (raw === null || raw === undefined || raw === '') return 0;

    // Jika sudah berupa number (terjadi saat valueRenderOption: UNFORMATTED_VALUE)
    if (typeof raw === 'number') {
      return isNaN(raw) ? 0 : Math.round(raw);
    }

    // Bersihkan prefix mata uang & spasi (tapi jangan hapus huruf lain sembarangan)
    // Hanya strip prefix di awal: "Rp", "IDR", "$", "USD"
    let cleaned = raw
      .toString()
      .trim()
      .replace(/^(Rp\.?|IDR|USD|\$)\s*/i, '') // hapus prefix mata uang di AWAL saja
      .replace(/\s/g, '')                       // hapus sisa spasi
      .replace(/\u00A0/g, '');                  // hapus non-breaking space

    if (!cleaned) return 0;

    const dotCount   = (cleaned.match(/\./g)  || []).length;
    const commaCount = (cleaned.match(/,/g)   || []).length;

    if (dotCount > 1 && commaCount === 0) {
      // "1.799.000" atau "1.799.000" → titik = ribuan
      cleaned = cleaned.replace(/\./g, '');

    } else if (commaCount > 1 && dotCount === 0) {
      // "1,799,000" → koma = ribuan
      cleaned = cleaned.replace(/,/g, '');

    } else if (dotCount > 1 && commaCount === 1) {
      // "1.799.000,00" (European dengan sen) → strip titik, ganti koma dengan titik
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');

    } else if (commaCount > 1 && dotCount === 1) {
      // "1,799,000.00" (US dengan sen) → strip koma
      cleaned = cleaned.replace(/,/g, '');

    } else if (dotCount === 1 && commaCount === 1) {
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
      const afterComma = cleaned.split(',')[1] ?? '';
      // Koma = ribuan HANYA jika tepat 3 digit setelahnya: "1,799"
      // Selain itu dianggap desimal: "1799,50"
      cleaned = afterComma.length === 3
        ? cleaned.replace(',', '')
        : cleaned.replace(',', '.');

    } else if (dotCount === 1 && commaCount === 0) {
      const afterDot = cleaned.split('.')[1] ?? '';
      // Titik = ribuan HANYA jika tepat 3 digit setelahnya: "1.799"
      // Selain itu dianggap desimal: "1799.50"
      if (afterDot.length === 3) {
        cleaned = cleaned.replace('.', '');
      }
      // "1799.50" → biarkan, titik = desimal
    }

    const result = parseFloat(cleaned);
    if (isNaN(result)) {
      this.logger.warn(`parsePrice: tidak bisa parse "${raw}" → hasil cleaned = "${cleaned}"`);
      return 0;
    }
    return Math.round(result);
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
      // FIX: UNFORMATTED_VALUE → Google Sheets mengembalikan angka mentah (misal: 1350000),
      // bukan string berformat (misal: "1.350.000" atau "Rp 1,35jt") yang bergantung locale sheet.
      // Tanpa ini, parseFloat("1.350.000") = 1.35 (berhenti di titik ke-2) → harga salah di DB.
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
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
      // Angka besar (misal: Shopee ID 196307583015) bisa muncul sebagai scientific notation
      // jika langsung toString() → pakai toFixed(0) untuk integer agar SKU tidak rusak
      const getValue = (row: any[], col: string): string | null => {
        const idx = headers.indexOf(col);
        if (idx === -1) return null;
        const val = row[idx];
        if (val === undefined || val === null || val.toString().trim() === '') return null;
        if (typeof val === 'number') {
          return Number.isInteger(val) ? val.toFixed(0) : val.toString();
        }
        return val.toString().trim();
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

      // ── CLEANUP: hapus variant & produk yang sudah tidak ada di sheet ────────
      let deletedVariants = 0;
      let deletedProducts = 0;

      try {
        // 1. Hapus variant yang tidak ada di sheet, per produk yang berhasil diproses
        //    Safety: hanya hapus jika tidak ada order item / cart item / wishlist
        for (const [skuParent, variantRows] of grouped) {
          const sheetSkusForProduct = variantRows
            .map((row: any[]) => getValue(row, 'sku'))
            .filter((s: string | null): s is string => s !== null);

          if (sheetSkusForProduct.length === 0) continue;

          const product = await this.prisma.product.findFirst({
            where: { skuParent },
            select: { id: true },
          });
          if (!product) continue;

          const del = await this.prisma.productVariant.deleteMany({
            where: {
              productId:  product.id,
              sku:        { notIn: sheetSkusForProduct },
              orderItems: { none: {} },
              cartItems:  { none: {} },
              wishlists:  { none: {} },
            },
          });
          deletedVariants += del.count;
        }

        // 2. Hapus produk yang tidak ada di sheet
        //    Safety: tidak ada ginee ID, tidak terhubung event,
        //    tidak ada review/wishlist, semua variantnya juga bersih
        const sheetSkuParentsList = Array.from(grouped.keys());
        const toDelete = await this.prisma.product.findMany({
          where: {
            AND: [
              { skuParent: { not: null } },
              { skuParent: { notIn: sheetSkuParentsList } },
            ],
            gineeProductId: null,
            eventProducts:  { none: {} },
            reviews:        { none: {} },
            wishlists:      { none: {} },
            variants: {
              every: {
                orderItems:    { none: {} },
                cartItems:     { none: {} },
                wishlists:     { none: {} },
                inventoryLogs: { none: {} },
              },
            },
          },
          select: { id: true },
        });

        if (toDelete.length > 0) {
          const del = await this.prisma.product.deleteMany({
            where: { id: { in: toDelete.map((p: any) => p.id) } },
          });
          deletedProducts = del.count;
        }

        if (deletedVariants > 0 || deletedProducts > 0) {
          this.logger.log(
            `Cleanup: ${deletedVariants} variant & ${deletedProducts} produk dihapus dari DB.`,
          );
        }
      } catch (cleanupErr: any) {
        this.logger.error('Cleanup error (sync tetap berhasil):', cleanupErr);
      }

      return {
        status:  result.errors.length > 0 ? 'partial' : 'success',
        message: `Berhasil sync ${result.synced} produk. Gagal: ${result.failed}. Dihapus: ${deletedVariants} variant & ${deletedProducts} produk.`,
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
          price:          finalVariantPrice,
          stockQuantity:  stock,
          availableStock: stock,
          imageUrl:       images,
          isActive:       true,
          ...(gineeSkuId && { gineeSkuId }),
        },
        create: {
          productId:      product.id,
          sku,
          price:          finalVariantPrice,
          stockQuantity:  stock,
          availableStock: stock,
          imageUrl:       images,
          isActive:       true,
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