import { Injectable, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { PrismaService } from 'src/prisma/prisma.service';
import { GineeClientService } from './ginee-client.service';
import slugify from 'slugify';

@Injectable()
export class GineeProductService {
  private readonly logger = new Logger(GineeProductService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gineeClient: GineeClientService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. WEBHOOK: UPDATE STOCK
  // ─────────────────────────────────────────────────────────────────────────────

  async updateStockFromWebhook(sku: string, newStock: number, eventId: string): Promise<void> {
    const idempotencyKey = `ginee:webhook:processed:${eventId}`;
    const alreadyProcessed = await this.cache.get(idempotencyKey);

    if (alreadyProcessed) {
      this.logger.log(`[Webhook] Duplicate event ${eventId} for SKU ${sku} — ignored`);
      return;
    }

    const variant = await this.prisma.productVariant.findUnique({ where: { sku } });

    if (!variant) {
      this.logger.warn(`[Webhook] SKU ${sku} not found locally — ignoring`);
      await this.cache.set(idempotencyKey, true, 86400);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.productVariant.update({
        where: { id: variant.id },
        data: { stockQuantity: newStock, gineeStockSyncAt: new Date() },
      });

      await tx.inventoryLog.create({
        data: {
          productVariantId: variant.id,
          type: 'ginee_sync',
          quantityChange: newStock - variant.stockQuantity,
          note: `Ginee webhook (eventId: ${eventId}) — ${variant.stockQuantity} → ${newStock}`,
          referenceId: `WEBHOOK-${eventId}`,
        },
      });
    });

    await this.cache.set(idempotencyKey, true, 86400);
    this.logger.log(`[Webhook] Stock updated SKU ${sku}: ${variant.stockQuantity} → ${newStock}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. WEBHOOK: HANDLE ORDER STOCK ADJUSTMENT
  // ─────────────────────────────────────────────────────────────────────────────

  async handleOrderWebhook(
    orderId: string,
    orderStatus: string,
    items: Array<{ sku: string; quantity: number }>,
    eventId: string,
  ): Promise<void> {
    const idempotencyKey = `ginee:webhook:processed:${eventId}`;
    const alreadyProcessed = await this.cache.get(idempotencyKey);

    if (alreadyProcessed) {
      this.logger.log(`[Webhook] Duplicate order event ${eventId} — ignored`);
      return;
    }

    const status = orderStatus.toUpperCase();
    const shouldDecrease = ['PAID', 'READY_TO_SHIP', 'PROCESSING'].includes(status);
    const shouldRestore  = status === 'CANCELLED';

    if (!shouldDecrease && !shouldRestore) {
      await this.cache.set(idempotencyKey, true, 86400);
      return;
    }

    for (const item of items) {
      const variant = await this.prisma.productVariant.findUnique({ where: { sku: item.sku } });

      if (!variant) {
        this.logger.warn(`[Order Webhook] SKU ${item.sku} not found — skipping`);
        continue;
      }

      const delta    = shouldDecrease ? -item.quantity : item.quantity;
      const newStock = Math.max(0, variant.stockQuantity + delta);

      await this.prisma.$transaction(async (tx) => {
        await tx.productVariant.update({
          where: { id: variant.id },
          data: { stockQuantity: newStock, gineeStockSyncAt: new Date() },
        });

        await tx.inventoryLog.create({
          data: {
            productVariantId: variant.id,
            type: 'adjustment',
            quantityChange: delta,
            note: `Order ${orderId} [${status}] — ${variant.stockQuantity} → ${newStock}`,
            referenceId: `ORDER-${orderId}`,
          },
        });
      });

      this.logger.log(`[Order Webhook] SKU ${item.sku} adjusted by ${delta} (order: ${orderId})`);
    }

    await this.cache.set(idempotencyKey, true, 86400);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. PUSH PRODUCT: Local → Ginee
  // ─────────────────────────────────────────────────────────────────────────────

  async pushProductToGinee(localProductId: number): Promise<{ gineeProductId: string }> {
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

    if (!product) throw new Error(`Product ID ${localProductId} not found`);
    if (product.variants.length === 0) throw new Error('Product must have at least 1 variant');

    // 1. Prepare Variations Payload
    const variations = product.variants.map((v) => {
      // Map variants to Ginee "optionValues" (e.g. ["Red", "L"])
      const optionValues = v.variantOptions.map(vo => vo.optionValue.value);

      return {
        ...(v.gineeSkuId ? { id: v.gineeSkuId } : {}), // Only send ID if updating
        sku: v.sku,
        // Ginee requires price inside an object
        sellingPrice: {
          amount: Number(v.price),
          currencyCode: 'IDR' // Adjust if multi-currency
        },
        purchasePrice: {
          amount: Number(v.price), // Optional: usually cost price
          currencyCode: 'IDR'
        },
        // Ginee requires stock inside an object
        stock: {
          availableStock: v.stockQuantity,
          warehouseId: process.env.GINEE_WAREHOUSE_ID // Optional: specific warehouse ID if needed
        },
        optionValues: optionValues.length > 0 ? optionValues : ["Default"],
        status: v.isActive ? 'ACTIVE' : 'DISABLED' // Ginee uses DISABLED, not INACTIVE
      };
    });

    // 2. Prepare Main Payload
    const basePayload = {
      name: product.name,
      categoryId: product.category?.gineeCategoryId || 'OTHERS',
      brand: product.brand?.gineeBrandId ?? undefined,
      // masterProductStatus: product.isActive ? 'ACTIVE' : 'InActive', 
      saleStatus: product.isActive ? 'FOR_SALE' : 'NOT_FOR_SALE',// Note: Case sensitive
      description: product.description ?? product.name,
      
      // Delivery info is required
      delivery: {
        weight: product.weightGrams,
        weightUnit: 'g', // g or kg
        length: 10, // Default dimensions if missing
        width: 10,
        height: 10,
        lengthUnit: 'cm'
      },
      
      // Variant Options Definition (e.g. [{name: "Color", values: ["Red", "Blue"]}])
      variantOptions: this.mapVariantOptions(product.variants),
      
      variations: variations
    };

    try {
      let response: any;

      if (product.gineeProductId) {
        // --- UPDATE ---
        this.logger.log(`[Push] Updating Ginee Product ${product.gineeProductId}...`);
        
        // Update endpoint expects 'productId' in the body
        // const updatePayload = {
        //     productId: product.gineeProductId, // <--- MUST BE HERE
        //     ...basePayload 
        // };

        // ✅ PERBAIKAN: Gunakan 'id', bukan 'productId'
        const updatePayload = {
            id: product.gineeProductId, // <--- Ubah ini jadi 'id'
            ...basePayload 
        };

        this.logger.log("Ini produk id untuk ginee" + updatePayload.id);
        response = await this.gineeClient.post('/openapi/product/master/v1/update', updatePayload);
        
        this.logger.debug(`[Push Payload] ${JSON.stringify(product.gineeProductId ? { productId: product.gineeProductId, ...basePayload } : basePayload, null, 2)}`);
        this.logger.debug(response);
        
      } else {
        // --- CREATE ---
        this.logger.log(`[Push] Creating new Ginee Product...`);
        
        // Create endpoint does NOT want productId
        response = await this.gineeClient.post('/openapi/product/master/v1/create', basePayload);
      }

      // 3. Handle Success
      const gineeProductId = response?.data?.productId ?? product.gineeProductId;
      
      await this.prisma.product.update({
        where: { id: product.id },
        data: { gineeProductId, gineeSyncStatus: 'synced' },
      });

      return { gineeProductId };

    } catch (error: any) {
      this.logger.error(`[Push] Failed: ${error.message}`);
      await this.prisma.gineeSyncLog.create({
        data: {
          type: 'push_product',
          status: 'failed',
          payloadSent: basePayload as any,
          errorMessage: error.message,
        },
      });
      throw error;
    }
  }

  // Helper to extract definitions like "Color", "Size" from local data
  private mapVariantOptions(variants: any[]) {
    const optionMap = new Map<string, Set<string>>();

    variants.forEach(v => {
        v.variantOptions.forEach((vo: any) => {
            const name = vo.optionValue.option.name;
            const value = vo.optionValue.value;
            
            if (!optionMap.has(name)) optionMap.set(name, new Set());
            optionMap.get(name)?.add(value);
        });
    });

    const result: any = [];
    for (const [name, values] of optionMap.entries()) {
        result.push({
            name: name,
            values: Array.from(values)
        });
    }

    // Ginee requires at least one variant option if there are variations
    if (result.length === 0) {
        return [{ name: "Variant", values: ["Default"] }];
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. PULL PRODUCT: Ginee → Local
  // ─────────────────────────────────────────────────────────────────────────────

  async pullProductFromGinee(
    gineeProductId: string,
    // Note: skipImageDownload parameter is now irrelevant but kept for signature compatibility
    skipImageDownload = false,
  ): Promise<{ status: string; productId: string }> {
    this.logger.log(`[Pull] Starting pull for Ginee product: ${gineeProductId}`);

    try {
      // 1. Fetch from Ginee (Using correct GET method and path)
      const response = await this.gineeClient.get('/openapi/product/master/v1/get', {
        productId: gineeProductId
      });
      
      const productRaw = response?.data;
      if (!productRaw) throw new Error('Product data not found in Ginee response');


      // 2. Prepare Master Images (Fallback for variants that don't have images)
      // Ginee returns images as string[]
      const productMasterImages: string[] = productRaw.images ?? [];

      await this.prisma.$transaction(async (tx) => {
        // Ensure category exists
        let defaultCategory = await tx.category.findFirst();
        if (!defaultCategory) {
            defaultCategory = await tx.category.create({ 
              data: { name: 'Uncategorized', gineeCategoryId: 'OTHERS', slug: 'uncategorized-' + Date.now() } 
            });
        }

        const slug = slugify(productRaw.name, { lower: true, strict: true }) + '-' + Date.now();

        // Upsert Product
        const product = await tx.product.upsert({
          where: { gineeProductId: productRaw.productId },
          update: {
            name: productRaw.name,
            description: productRaw.description,
            weightGrams: productRaw.delivery?.weight ?? 1000,
            isActive: productRaw.saleStatus === 'FOR_SALE',
            gineeSyncStatus: 'synced',
          },
          create: {
            name: productRaw.name, slug,
            description: productRaw.description,
            weightGrams: productRaw.delivery?.weight ?? 1000,
            isActive: productRaw.saleStatus === 'FOR_SALE',
            basePrice: 0, 
            categoryId: defaultCategory.id,
            gineeProductId: productRaw.productId, 
            gineeSyncStatus: 'synced',
          },
        });

        // Get attribute definitions (Size, Color, etc.)
        const attributeObjects: any[] = productRaw.variantOptions ?? [];

        // Process Variations
        for (const variantRaw of productRaw.variations ?? []) {
          
          // ⚠️ CHANGED: Determine images for this variant.
          // If variant has specific images, use them. Otherwise, use master product images.
          const variantSpecificImages = variantRaw.images ?? [];
          const finalImages = variantSpecificImages.length > 0 ? variantSpecificImages : productMasterImages;

          // 1. Create/Update Variant
          const variant = await tx.productVariant.upsert({
            where: { gineeSkuId: variantRaw.id },
            update: {
              sku: variantRaw.sku, 
              price: variantRaw.sellingPrice?.amount ?? 0,
              stockQuantity: variantRaw.stock?.availableStock ?? 0,
              imageUrl: finalImages, // ✅ Storing array directly
              isActive: variantRaw.status === 'ACTIVE',
            },
            create: {
              productId: product.id, 
              sku: variantRaw.sku, 
              gineeSkuId: variantRaw.id,
              price: variantRaw.sellingPrice?.amount ?? 0, 
              stockQuantity: variantRaw.stock?.availableStock ?? 0,
              imageUrl: finalImages, // ✅ Storing array directly
              isActive: variantRaw.status === 'ACTIVE',
            },
          });

          // 2. Link Options (Color, Size, etc.)
          if (attributeObjects.length > 0 && variantRaw.optionValues) {
            for (let i = 0; i < attributeObjects.length; i++) {
              const optName = attributeObjects[i]?.name; 
              const optVal  = variantRaw.optionValues[i];

              if (!optName || !optVal || optVal === '-') continue;

              // Find or Create Option
              let optionMaster = await tx.option.findFirst({ where: { name: optName } });
              if (!optionMaster) optionMaster = await tx.option.create({ data: { name: optName } });

              // Find or Create Value
              let valMaster = await tx.optionValue.findFirst({ where: { optionId: optionMaster.id, value: optVal } });
              if (!valMaster) valMaster = await tx.optionValue.create({ data: { optionId: optionMaster.id, value: optVal } });

              // Link to Variant
              await tx.variantOption.upsert({
                where: { variantId_optionValueId: { variantId: variant.id, optionValueId: valMaster.id } },
                update: {},
                create: { variantId: variant.id, optionValueId: valMaster.id },
              });
            }
          }
        }

        // Update product base price to match cheapest variant
        const cheapest = await tx.productVariant.findFirst({ where: { productId: product.id }, orderBy: { price: 'asc' } });
        if (cheapest) await tx.product.update({ where: { id: product.id }, data: { basePrice: cheapest.price } });
      });

      this.logger.log(`[Pull] Successfully pulled: ${gineeProductId}`);
      return { status: 'SUCCESS', productId: gineeProductId };
    } catch (error: any) {
      this.logger.error(`[Pull] Failed for ${gineeProductId}: ${error.message}`);
      await this.prisma.gineeSyncLog.create({
        data: {
          type: 'pull_product',
          status: 'failed',
          errorMessage: error.message,
          payloadSent: { productId: gineeProductId },
        },
      });
      throw error;
    }
  }
}