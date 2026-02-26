import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { google } from 'googleapis';
import slugify from 'slugify';

@Injectable()
export class SyncProductsService {
  private readonly logger = new Logger(SyncProductsService.name);

  constructor(private prisma: PrismaService) {}

  async syncFromGoogleSheet() {
    // 1. Setup Auth Google Sheets
    const auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    // Pastikan ID Spreadsheet & Range sesuai ENV atau Default
    const spreadsheetId = process.env.GOOGLE_PRODUCT_SPREADSHEET_ID; 
    const sheetName = process.env.GOOGLE_PRODUCT_SHEET_NAME || 'data_front';
    const rangeData = process.env.GOOGLE_PRODUCT_RANGE || 'A1:Z3000';
    const range = `${sheetName}!${rangeData}`;

    this.logger.log(`Starting sync Products from Sheet: ${sheetName}`);

    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        this.logger.warn('No data found in spreadsheet range.');
        return { message: 'No data found' };
      }

      // 2. Mapping Header (Normalize ke lowercase & trim)
      // Pastikan di Google Sheet nama kolomnya: "available_size"
      const rawHeaders = rows[0];
      const headers = rows[0].map((h) => h.toLowerCase().trim().replace(/ /g, '_')); // replace spasi jadi underscore
      
      this.logger.log(`Detected Headers: ${headers.join(', ')}`);

      if (!headers.includes('sku_parent')) {
        throw new Error('Column "sku_parent" is missing!');
      }

      // Helper untuk ambil value berdasarkan nama kolom
      const getValue = (row: any[], colName: string) => {
        const index = headers.indexOf(colName);
        return index !== -1 ? (row[index] ? row[index].toString().trim() : null) : null;
      };

      const dataRows = rows.slice(1);

      // 3. Grouping Data by SKU Parent
      const groupedProducts: any = new Map<string, any[]>();
      for (const row of dataRows) {
        const skuParent = getValue(row, 'sku_parent');
        if (skuParent) {
            if (!groupedProducts.has(skuParent)) groupedProducts.set(skuParent, []);
            groupedProducts.get(skuParent).push(row);
        }
      }

      this.logger.log(`Processing ${groupedProducts.size} parent products...`);

      // 4. Pre-fetch / Create Option "Size" agar tidak query berulang kali
      const sizeOption = await this.findOrCreateOption('Size');

      let syncedCount = 0;

      // 5. Loop Utama (Per Produk)
      for (const [skuParent, variantsRows] of groupedProducts) {
        const firstRow = variantsRows[0];

        // --- A. Handle Product Parent ---
        const productName = getValue(firstRow, 'product_name') || getValue(firstRow, 'name');
        const brandName = getValue(firstRow, 'brand');
        const categoryName = getValue(firstRow, 'product_type') || 'Uncategorized';
        
        // Logic Harga Parent (Ambil dari varian pertama)
        const basePrice = parseFloat(getValue(firstRow, 'price') || '0');
        
        const brand = await this.findOrCreateBrand(brandName);
        const category = await this.findOrCreateCategory(categoryName);
        
        // Buat Slug unik
        const slug = slugify(`${productName}-${skuParent}`, { lower: true, strict: true });

        const productData = {
            name: productName,
            description: getValue(firstRow, 'description') || '',
            slug: slug,
            basePrice: basePrice,
            weightGrams: parseFloat(getValue(firstRow, 'weight') || '1000'),
            brandId: brand ? brand.id : null,
            categoryId: category.id,
            isActive: true
        };

        const product = await this.prisma.product.upsert({
            where: { slug: slug },
            update: productData,
            create: { ...productData, categoryId: category.id }, // Pastikan ID category masuk
        });

        // --- B. Handle Variants (Loop setiap row varian) ---
        for (const row of variantsRows) {
            const sku = getValue(row, 'sku');
            if (!sku) continue;

            const price = parseFloat(getValue(row, 'price') || '0');
            const salePrice = parseFloat(getValue(row, 'sale_price') || '0');
            const stock = parseInt(getValue(row, 'stock_quantity') || '0');
            const imageUrl = getValue(row, 'images_1') || getValue(row, 'image_url') || '';
            
            // Ambil data Size dari kolom 'available_size'
            const sizeValueStr = getValue(row, 'available_sizes'); 

            // Upsert Product Variant
            const variant = await this.prisma.productVariant.upsert({
                where: { sku: sku },
                update: {
                    price: salePrice > 0 ? salePrice : price,
                    stockQuantity: stock,
                    imageUrl: imageUrl,
                    isActive: true
                },
                create: {
                    productId: product.id,
                    sku: sku,
                    price: salePrice > 0 ? salePrice : price,
                    stockQuantity: stock,
                    imageUrl: imageUrl,
                    isActive: true
                }
            });

            // --- C. Handle Option Value (Mapping Size) ---
            if (sizeValueStr && sizeOption) {
                // 1. Cari atau Buat Value (misal: "40", "XL")
                const optionValue = await this.findOrCreateOptionValue(sizeOption.id, sizeValueStr);

                // 2. Hubungkan Variant dengan OptionValue (Isi tabel VariantOption)
                // Kita pakai try-catch atau upsert manual logic karena Prisma Composite ID agak tricky
                try {
                    // Cek apakah relasi sudah ada
                    const existingRelation = await this.prisma.variantOption.findUnique({
                        where: {
                            variantId_optionValueId: {
                                variantId: variant.id,
                                optionValueId: optionValue.id
                            }
                        }
                    });

                    if (!existingRelation) {
                        await this.prisma.variantOption.create({
                            data: {
                                variantId: variant.id,
                                optionValueId: optionValue.id
                            }
                        });
                    }
                } catch (e) {
                    this.logger.error(`Failed to link Option Size ${sizeValueStr} to SKU ${sku}`, e);
                }
            }
        }

        syncedCount++;
      }

      return { status: 'success', message: `Synced ${syncedCount} products with variants.` };

    } catch (error) {
      this.logger.error('Sync failed:', error);
      throw error;
    }
  }

  // --- HELPER FUNCTIONS ---

  private async findOrCreateBrand(name: string | null) {
    if (!name) return null;
    const cleanName = name.trim();
    // Gunakan upsert atau findFirst+create
    let brand = await this.prisma.brand.findFirst({ where: { name: cleanName } });
    if (!brand) {
      const slug = slugify(cleanName, { lower: true, strict: true });
      brand = await this.prisma.brand.create({ 
          data: { name: cleanName, slug: slug } 
      });
    }
    return brand;
  }

  private async findOrCreateCategory(name: string | null) {
    const cleanName = name ? name.trim() : 'Uncategorized';
    let category = await this.prisma.category.findFirst({ where: { name: cleanName } });
    if (!category) {
      const slug = slugify(cleanName, { lower: true, strict: true });
      category = await this.prisma.category.create({ 
          data: { name: cleanName, slug: slug } 
      });
    }
    return category;
  }

  // Helper baru untuk Option (Size)
  private async findOrCreateOption(name: string) {
    let option = await this.prisma.option.findFirst({ where: { name: name } });
    if (!option) {
        option = await this.prisma.option.create({ data: { name: name } });
    }
    return option;
  }

  // Helper baru untuk OptionValue (40, 41, XL, dll)
  private async findOrCreateOptionValue(optionId: bigint, value: string) {
    let optValue = await this.prisma.optionValue.findFirst({
        where: {
            optionId: optionId,
            value: value
        }
    });

    if (!optValue) {
        optValue = await this.prisma.optionValue.create({
            data: {
                optionId: optionId,
                value: value
            }
        });
    }
    return optValue;
  }
}