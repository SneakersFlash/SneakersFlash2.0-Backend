import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { GineeClientService } from './ginee-client.service';

@Injectable()
export class GineeProductService {
    private readonly logger = new Logger(GineeProductService.name);

    constructor(
        private prisma: PrismaService,
        private gineeClient: GineeClientService,
    ) {}

    // 1. PUSH PRODUCT (Lokal -> Ginee)
    async pushProductToGinee(localProductId: number) {
        // Ambil data lengkap dengan deep include
        const product = await this.prisma.product.findUnique({
        where: { id: BigInt(localProductId) },
        include: {
            brand: true,
            category: true,
            variants: {
            include: {
                variantOptions: {
                include: { optionValue: { include: { option: true } } },
                },
            },
            },
        },
        });

        if (!product) throw new Error('Product not found');

        // MAPPING DATA (Prisma -> Ginee JSON)
        const payload = {
        productName: product.name,
        // Mapping Kategori (Harus punya gineeCategoryId di DB)
        categoryId: product.category?.gineeCategoryId || 'OTHERS_ID', 
        brandId: product.brand?.gineeBrandId, 
        status: product.isActive ? 'ACTIVE' : 'INACTIVE',
        shortDescription: product.description?.substring(0, 500),
        description: product.description,
        weight: product.weightGrams,
        
        // Mapping SKU & Varian
        skus: product.variants.map((v) => {
            // Ambil atribut size/color
            const specs = {};
            v.variantOptions.forEach((vo) => {
            specs[vo.optionValue.option.name] = vo.optionValue.value;
            });

            return {
            merchantSku: v.sku, // SKU Induk
            price: Number(v.price),
            stock: v.stockQuantity,
            specification: specs, // { "Size": "40", "Color": "Red" }
            };
        }),
        };

        // KIRIM KE GINEE
        try {
        this.logger.log(`Pushing product ${product.slug} to Ginee...`);
        const response: any = await this.gineeClient.post('/product/create', payload);
        
        // UPDATE BALIK DB LOKAL
        // Simpan Ginee ID yang didapat dari response
        await this.prisma.product.update({
            where: { id: product.id },
            data: {
            gineeProductId: response.data.productId,
            gineeSyncStatus: 'synced', // enum [cite: 18]
            },
        });

        return response;
        } catch (error: any) {
        // Log Error ke table GineeSyncLog [cite: 26]
        await this.prisma.gineeSyncLog.create({
            data: {
                type: 'pull_product', // sesuaikan enum
                status: 'failed',
                payloadSent: payload as any,
                errorMessage: error.message
            }
        });
        throw error;
        }
    }

    // 2. UPDATE STOCK FROM GINEE (Webhook Handler)
    async updateStockFromWebhook(sku: string, newStock: number) {
        const variant = await this.prisma.productVariant.findUnique({
        where: { sku },
        });

        if (variant) {
        await this.prisma.productVariant.update({
            where: { id: variant.id },
            data: { 
                stockQuantity: newStock,
                gineeStockSyncAt: new Date() // [cite: 22]
            },
        });
        
        // Catat di Inventory Log [cite: 28]
        await this.prisma.inventoryLog.create({
            data: {
                productVariantId: variant.id,
                type: 'ginee_sync', // enum [cite: 29]
                quantityChange: newStock - variant.stockQuantity,
                note: 'Auto sync from Ginee Webhook',
                referenceId: 'WEBHOOK-GINEE'
            }
        });
        
        this.logger.log(`Updated stock for SKU ${sku} to ${newStock}`);
        }
    }
}