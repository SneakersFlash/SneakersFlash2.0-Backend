import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { google } from 'googleapis';
import slugify from 'slugify';
import { Category } from '@prisma/client';

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

      // 2. Mapping Header
      const rawHeaders = rows[0];
      const headers = rows[0].map((h) => h.toLowerCase().trim().replace(/ /g, '_'));
      
      this.logger.log(`Detected Headers: ${headers.join(', ')}`);

      if (!headers.includes('sku_parent')) {
        throw new Error('Column "sku_parent" is missing!');
      }

      // Helper ambil value
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

      // 4. Pre-fetch / Create Option "Size"
      const sizeOption = await this.findOrCreateOption('Size');

      let syncedCount = 0;

      // 5. Loop Utama (Per Produk)
      for (const [skuParent, variantsRows] of groupedProducts) {
        const firstRow = variantsRows[0];

        // --- A. Handle Product Parent ---
        const productName = getValue(firstRow, 'product_name') || getValue(firstRow, 'name');
        const brandName = getValue(firstRow, 'brand');
        const categoryRawStr = getValue(firstRow, 'product_type') || 'Uncategorized';
        
        const basePrice = parseFloat(getValue(firstRow, 'price') || '0');
        
        const brand = await this.findOrCreateBrand(brandName);
        const categoriesData = await this.findOrCreateCategory(categoryRawStr);
        const categoryConnections = categoriesData.map(cat => ({ id: cat.id }));

        const slug = slugify(`${productName}-${skuParent}`, { lower: true, strict: true });

        const productData = {
            name: productName,
            description: getValue(firstRow, 'description') || '',
            slug: slug,
            basePrice: basePrice,
            weightGrams: parseFloat(getValue(firstRow, 'weight') || '1000'),
            brandId: brand ? brand.id : null,
            isActive: true
        };

        // ⚠️ CHANGED: Use `connect` or `set` for Many-to-Many relation
        const product = await this.prisma.product.upsert({
            where: { slug: slug },
            update: {
                ...productData,
                categories: {
                    set: categoryConnections // Timpa dengan list kategori terbaru
                }
            },
            create: { 
                ...productData, 
                categories: {
                    connect: categoryConnections // Sambungkan saat pertama kali buat
                }
            },
        });

        // --- B. Handle Variants (Loop setiap row varian) ---
        for (const row of variantsRows) {
            const sku = getValue(row, 'sku');
            if (!sku) continue;

            const price = parseFloat(getValue(row, 'price') || '0');
            const salePrice = parseFloat(getValue(row, 'sale_price') || '0');
            const stock = parseInt(getValue(row, 'stock_quantity') || '0');

            // ⚠️ CHANGED: Logic to grab multiple images and put into array
            const images: string[] = [];

            // Tambahkan pengecekan baik untuk 'image_1' maupun 'images_1'
            const img1 = getValue(row, 'image_1') || getValue(row, 'images_1');
            const img2 = getValue(row, 'image_2') || getValue(row, 'images_2');
            const img3 = getValue(row, 'image_3') || getValue(row, 'images_3');
            const img4 = getValue(row, 'image_4') || getValue(row, 'images_4');
            const img5 = getValue(row, 'image_5') || getValue(row, 'images_5');
            const imgUrl = getValue(row, 'image_url'); 

            if (img1) images.push(img1);
            if (img2) images.push(img2);
            if (img3) images.push(img3);
            if (img4) images.push(img4);
            if (img5) images.push(img5);

            // Jika dari img1-img5 kosong, kita proses imgUrl
            if (images.length === 0 && imgUrl) {
                // Cek apakah dipisah dengan koma
                if (imgUrl.includes(',')) {
                    imgUrl.split(',').forEach(s => { 
                        if(s.trim()) images.push(s.trim()) 
                    });
                } 
                // Cek apakah dipisah dengan baris baru (enter)
                else if (imgUrl.includes('\n')) {
                    imgUrl.split('\n').forEach(s => { 
                        if(s.trim()) images.push(s.trim()) 
                    });
                } 
                // Jika tidak ada pemisah, masukkan sebagai 1 gambar
                else {
                    if(imgUrl.trim()) images.push(imgUrl.trim());
                }
            }
            
            const sizeValueStr = getValue(row, 'available_sizes'); 

            // Upsert Product Variant with imageUrl
            const variant = await this.prisma.productVariant.upsert({
                where: { sku: sku },
                update: {
                    price: salePrice > 0 ? salePrice : price,
                    stockQuantity: stock,
                    imageUrl: images, // ✅ Save as Array
                    isActive: true
                },
                create: {
                    productId: product.id,
                    sku: sku,
                    price: salePrice > 0 ? salePrice : price,
                    stockQuantity: stock,
                    imageUrl: images, // ✅ Save as Array
                    isActive: true
                }
            });

            // --- C. Handle Option Value (Mapping Size) ---
            if (sizeValueStr && sizeOption) {
                const optionValue = await this.findOrCreateOptionValue(sizeOption.id, sizeValueStr);

                try {
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
    let brand = await this.prisma.brand.findFirst({ where: { name: cleanName } });
    if (!brand) {
      const slug = slugify(cleanName, { lower: true, strict: true });
      brand = await this.prisma.brand.create({ 
          data: { name: cleanName, slug: slug } 
      });
    }
    return brand;
  }

  // ⚠️ NEW HELPER: Process comma-separated categories
  private async findOrCreateCategory(categoryRawStr: string) {
    // 1. Pecah string berdasarkan koma
    const rawCategories = categoryRawStr.split(',');
    
    // 2. Bersihkan spasi kosong dan buang duplikat
    const uniqueCategories = [...new Set(
        rawCategories
            .map(c => c.trim())
            .filter(c => c.length > 0)
    )];

    // Jika kosong, masukkan ke Uncategorized
    if (uniqueCategories.length === 0) {
        uniqueCategories.push('Uncategorized');
    }

    // ✅ PERBAIKAN: Definisikan tipe array sebagai Category[]
    const resultCategories: Category[] = [];

    // 3. Loop dan cari/buat setiap kategori
    for (const catName of uniqueCategories) {
        let category = await this.prisma.category.findFirst({ where: { name: catName } });
        
        if (!category) {
            const slug = slugify(catName, { lower: true, strict: true });
            const existingSlug = await this.prisma.category.findUnique({ where: { slug: slug }});
            
            if(existingSlug) {
                category = existingSlug;
            } else {
                 category = await this.prisma.category.create({ 
                    data: { name: catName, slug: slug } 
                });
            }
        }
        
        // Sekarang TypeScript tahu bahwa category boleh di-push ke sini
        resultCategories.push(category);
    }

    return resultCategories;
  }

  private async findOrCreateOption(name: string) {
    let option = await this.prisma.option.findFirst({ where: { name: name } });
    if (!option) {
        option = await this.prisma.option.create({ data: { name: name } });
    }
    return option;
  }

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