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
    // Uses NestJS built-in cache manager (backed by Redis via cache-manager-ioredis)
    // Make sure CacheModule.register({ store: redisStore, ... }) is in AppModule
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. WEBHOOK: UPDATE STOCK (with idempotency)
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
          type: 'ginee_sync',                                         // ✅ Valid enum value
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
            type: 'adjustment',                                       // ✅ Valid enum value
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

    const payload: Record<string, any> = {
      productName: product.name,
      categoryId:  product.category?.gineeCategoryId ?? 'OTHERS',
      brandId:     product.brand?.gineeBrandId ?? undefined,
      status:      product.isActive ? 'ACTIVE' : 'INACTIVE',
      description: product.description ?? product.name,
      weight:      product.weightGrams,
      skus: product.variants.map((v) => {
        const specs: Record<string, string> = {};
        v.variantOptions.forEach((vo) => {
          specs[vo.optionValue.option.name] = vo.optionValue.value;
        });
        return { merchantSku: v.sku, price: Number(v.price), stock: v.stockQuantity, variationAttribute: specs };
      }),
    };

    try {
      let response: any;
      if (product.gineeProductId) {
        payload.productId = product.gineeProductId;
        response = await this.gineeClient.post('/product/master/edit', payload);
      } else {
        response = await this.gineeClient.post('/product/create', payload);
      }

      const gineeProductId = response?.data?.productId ?? product.gineeProductId;
      await this.prisma.product.update({
        where: { id: product.id },
        data: { gineeProductId, gineeSyncStatus: 'synced' },
      });
      return { gineeProductId };
    } catch (error: any) {
      await this.prisma.gineeSyncLog.create({
        data: {
          type: 'push_order',                                         // ✅ Closest valid GineeLogType
          status: 'failed',                                           // ✅ Valid GineeLogStatus
          payloadSent: payload,
          errorMessage: error.message,
        },
      });
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. PULL PRODUCT: Ginee → Local
  // ─────────────────────────────────────────────────────────────────────────────

  async pullProductFromGinee(
    gineeProductId: string,
    skipImageDownload = false,
  ): Promise<{ status: string; productId: string }> {
    this.logger.log(`[Pull] Starting pull for Ginee product: ${gineeProductId}`);

    try {
      const response   = await this.gineeClient.post('/product/master/get', { productId: gineeProductId });
      const productRaw = response?.data;
      if (!productRaw) throw new Error('Product data not found in Ginee response');

      const mainImageFilename = skipImageDownload ? null : await this.downloadImage(productRaw.images?.[0] ?? null);

      await this.prisma.$transaction(async (tx) => {
        const defaultCategory = await tx.category.findFirst();
        if (!defaultCategory) throw new Error('Create at least 1 Category in the local database first');

        const slug = slugify(productRaw.name, { lower: true, strict: true }) + '-' + Date.now();

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
            basePrice: 0, categoryId: defaultCategory.id,
            gineeProductId: productRaw.productId, gineeSyncStatus: 'synced',
          },
        });

        for (const variantRaw of productRaw.variations ?? []) {
          const varImgFilename = skipImageDownload ? null : await this.downloadImage(variantRaw.images?.[0] ?? null);

          const variant = await tx.productVariant.upsert({
            where: { gineeSkuId: variantRaw.id },
            update: {
              sku: variantRaw.sku, price: variantRaw.sellingPrice?.amount ?? 0,
              stockQuantity: variantRaw.stock?.availableStock ?? 0,
              imageUrl: varImgFilename ?? mainImageFilename, isActive: variantRaw.status === 'ACTIVE',
            },
            create: {
              productId: product.id, sku: variantRaw.sku, gineeSkuId: variantRaw.id,
              price: variantRaw.sellingPrice?.amount ?? 0, stockQuantity: variantRaw.stock?.availableStock ?? 0,
              imageUrl: varImgFilename ?? mainImageFilename, isActive: variantRaw.status === 'ACTIVE',
            },
          });

          const attributeNames: string[] = productRaw.variantOptions ?? [];
          if (attributeNames.length > 0 && variantRaw.optionValues) {
            for (let i = 0; i < attributeNames.length; i++) {
              const optName = attributeNames[i];
              const optVal  = variantRaw.optionValues[i];
              if (!optVal || optVal === '-') continue;

              let optionMaster = await tx.option.findFirst({ where: { name: optName } });
              if (!optionMaster) optionMaster = await tx.option.create({ data: { name: optName } });

              let valMaster = await tx.optionValue.findFirst({ where: { optionId: optionMaster.id, value: optVal } });
              if (!valMaster) valMaster = await tx.optionValue.create({ data: { optionId: optionMaster.id, value: optVal } });

              await tx.variantOption.upsert({
                where: { variantId_optionValueId: { variantId: variant.id, optionValueId: valMaster.id } },
                update: {},
                create: { variantId: variant.id, optionValueId: valMaster.id },
              });
            }
          }
        }

        const cheapest = await tx.productVariant.findFirst({ where: { productId: product.id }, orderBy: { price: 'asc' } });
        if (cheapest) await tx.product.update({ where: { id: product.id }, data: { basePrice: cheapest.price } });
      });

      this.logger.log(`[Pull] Successfully pulled: ${gineeProductId}`);
      return { status: 'SUCCESS', productId: gineeProductId };
    } catch (error: any) {
      this.logger.error(`[Pull] Failed for ${gineeProductId}: ${error.message}`);
      await this.prisma.gineeSyncLog.create({
        data: {
          type: 'pull_product',                                       // ✅ Valid GineeLogType
          status: 'failed',                                           // ✅ Valid GineeLogStatus
          errorMessage: error.message,
          payloadSent: { productId: gineeProductId },
        },
      });
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: Download image
  // ─────────────────────────────────────────────────────────────────────────────

  private async downloadImage(url: string | null): Promise<string | null> {
    if (!url) return null;
    try {
      const fs    = await import('fs');
      const path  = await import('path');
      const axios = (await import('axios')).default;
      const uploadsDir = path.join(process.cwd(), 'uploads');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      const ext      = path.extname(url) || '.jpg';
      const filename = `ginee-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      const filePath = path.join(uploadsDir, filename);
      const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 10_000 });
      const writer   = fs.createWriteStream(filePath);
      response.data.pipe(writer);
      return new Promise<string>((resolve, reject) => {
        writer.on('finish', () => resolve(`uploads/${filename}`));
        writer.on('error', reject);
      });
    } catch (error: any) {
      this.logger.warn(`[Image] Failed to download ${url}: ${error.message}`);
      return null;
    }
  }
}