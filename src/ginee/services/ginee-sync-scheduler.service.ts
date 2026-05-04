import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class GineeSyncSchedulerService {
  private readonly logger = new Logger(GineeSyncSchedulerService.name);
  private isSyncing = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('ginee-queue') private readonly gineeQueue: Queue,
  ) {}

  @Cron('0 * * * *') // Every hour at :00
  async scheduleRegularProductStockPush() {
    if (this.isSyncing) {
      this.logger.warn('[Scheduler] Previous sync still running — skipped');
      return;
    }

    this.isSyncing = true;
    const now = new Date();

    try {
      this.logger.log('[Scheduler] Starting hourly stock push for regular products...');

      // Regular products: active, already synced to Ginee, NOT in any currently active event
      const regularProducts = await this.prisma.product.findMany({
        where: {
          isActive: true,
          gineeProductId: { not: null },
          eventProducts: {
            none: {
              event: {
                startAt: { lte: now },
                endAt: { gte: now },
                isActive: true,
              },
            },
          },
        },
        select: { id: true, gineeProductId: true },
      });

      if (regularProducts.length === 0) {
        this.logger.log('[Scheduler] No regular products to sync.');
        return;
      }

      this.logger.log(`[Scheduler] Queuing ${regularProducts.length} regular products...`);

      // Stagger 2s per product to avoid Ginee rate limits
      for (let i = 0; i < regularProducts.length; i++) {
        const product = regularProducts[i];
        await this.gineeQueue.add(
          'push-product',
          { productId: Number(product.id) },
          {
            delay: i * 2000,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            jobId: `scheduled-push-${product.id}-${now.getTime()}`,
          },
        );
      }

      this.logger.log(`[Scheduler] ${regularProducts.length} products queued — next run in ~1 hour.`);
    } catch (error: any) {
      this.logger.error(`[Scheduler] Failed to queue products: ${error.message}`);
    } finally {
      this.isSyncing = false;
    }
  }
}
