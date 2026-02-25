import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import axios from 'axios';

@Injectable()
export class GineeProductService {
  private readonly logger = new Logger(GineeProductService.name);

  constructor(private prisma: PrismaService) {}

  // 1. Ambil Produk Lokal Lengkap
  async getLocalProductForGinee(productId: bigint) {
    return this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        brand: true,
        category: true,
        variants: {
          include: {
            variantOptions: {
              include: {
                optionValue: {
                  include: { option: true } // Penting: Ambil nama Option ("Size")
                }
              }
            }
          }
        }
      }
    });
  }

  // 2. Transform Data (Logic Utama)
  formatPayloadForGinee(localProduct: any) {
    // A. Kumpulkan semua Nama Variasi (Contoh: ["Size", "Color"])
    const variationKeys = new Set<string>();
    localProduct.variants.forEach((v: any) => {
      v.variantOptions.forEach((vo: any) => {
        variationKeys.add(vo.optionValue.option.name);
      });
    });

    // B. Build SKU List untuk Ginee
    const skuList = localProduct.variants.map((v: any) => {
      // Bikin object spesifikasi: { "Size": "40", "Color": "Red" }
      const specs: Record<string, string> = {};
      
      v.variantOptions.forEach((vo: any) => {
        const key = vo.optionValue.option.name;   // "Size"
        const val = vo.optionValue.value;         // "40"
        specs[key] = val;
      });

      return {
        merchantSku: v.sku, // SKU Induk kita
        price: Number(v.price),
        stock: v.stockQuantity,
        // Ginee biasanya minta array of attribute atau map
        variationAttribute: specs 
      };
    });

    // C. Return Payload Akhir
    return {
      productName: localProduct.name,
      productStatus: localProduct.isActive ? 'Active' : 'Inactive',
      brand: localProduct.brand?.name,
      category: localProduct.category?.name, // Perlu mapping ID Ginee sebenarnya
      weight: localProduct.weightGrams,
      
      // Data Varian
      variations: Array.from(variationKeys), // ["Size"]
      skus: skuList
    };
  }

  // 3. Fungsi Sync (Push ke Ginee)
  async pushProductToGinee(localProductId: number) {
    try {
      const product = await this.getLocalProductForGinee(BigInt(localProductId));
      if (!product) throw new Error("Product not found");

      // Convert ke format Ginee
      const payload = this.formatPayloadForGinee(product);
      this.logger.log(`Pushing to Ginee: ${JSON.stringify(payload)}`);

      // --- CALL API GINEE (Pseudo Code) ---
      // const response = await axios.post('https://api.ginee.com/open/v1/product/create', payload, { headers: ... });
      
      // Jika Sukses, simpan ID Ginee ke Database lokal kita
      // const gineeId = response.data.productId;
      
      // await this.prisma.product.update({
      //   where: { id: BigInt(localProductId) },
      //   data: { gineeProductId: gineeId, gineeSyncStatus: 'synced' }
      // });

      return payload; // Untuk testing, return payload dulu
      
    } catch (error) {
      this.logger.error("Ginee Push Error", error);
      throw error;
    }
  }
}