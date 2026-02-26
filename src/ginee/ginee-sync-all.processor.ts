import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { GineeProductService } from './services/ginee-product.service';
import { GineeClientService } from './services/ginee-client.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { SyncAllResult, SyncResult } from './ginee.types';

const CONCURRENCY   = 5;      // Products processed in parallel per page chunk
const PAGE_DELAY_MS = 1_500;  // Pause between Ginee API pages (rate limit buffer)
const PAGE_SIZE     = 50;     // Products per Ginee API request

@Processor('ginee-sync-all-queue')
export class GineeSyncAllProcessor {
  private readonly logger = new Logger(GineeSyncAllProcessor.name);

  constructor(
    private readonly gineeProductService: GineeProductService,
    private readonly gineeClient: GineeClientService,
    private readonly prisma: PrismaService,
  ) {}

  @Process({ name: 'sync-all-products', concurrency: 1 }) // Only 1 bulk sync at a time
  async handleSyncAll(job: Job<{ dryRun: boolean }>): Promise<SyncAllResult> {
    const { dryRun } = job.data;
    const sessionId = `SYNC-${Date.now()}`;
    this.logger.log(`🚀 [SyncAll] Session ${sessionId} — dryRun: ${dryRun}`);

    let page = 0;
    let hasMore = true;
    const result: SyncAllResult = { sessionId, totalFetched: 0, success: 0, skipped: 0, failed: 0, dryRun };

    try {
      while (hasMore) {
        this.logger.log(`[SyncAll] Fetching page ${page}...`);

        let response: any;
        try {
          response = await this.gineeClient.post('/product/master/page', {
            page, limit: PAGE_SIZE, status: 'ACTIVE',
          });
        } catch (err: any) {
          this.logger.error(`[SyncAll] Failed to fetch page ${page}: ${err.message}`);
          throw err; // Stop entirely on API failure
        }

        const products: any[] = response.data?.content ?? [];
        if (products.length === 0) { hasMore = false; break; }

        result.totalFetched += products.length;

        // Process in controlled chunks (CONCURRENCY at a time) instead of all 50 at once
        const syncResults = await this.processChunked(products, dryRun, CONCURRENCY);
        for (const r of syncResults) {
          if (r.status === 'SUCCESS')       result.success++;
          else if (r.status === 'SKIPPED')  result.skipped++;
          else                              result.failed++;
        }

        const totalPages = response.data?.totalPages ?? 1;
        await job.progress(Math.round(((page + 1) / totalPages) * 100));

        this.logger.log(
          `[SyncAll] Page ${page} — fetched: ${result.totalFetched}, ✅ ${result.success}, ⏭ ${result.skipped}, ❌ ${result.failed}`,
        );

        page++;
        if (page >= totalPages) {
          hasMore = false;
        } else {
          await this.sleep(PAGE_DELAY_MS); // Rate limit buffer
        }
      }

      await this.saveSummaryLog(result);
      this.logger.log(`✅ [SyncAll] Session ${sessionId} completed`);
      return result;

    } catch (error: any) {
      this.logger.error(`💥 [SyncAll] Session ${sessionId} failed: ${error.message}`);
      await this.saveSummaryLog({ ...result, failed: result.failed + 1 }).catch(() => null);
      throw error;
    }
  }

  private async processChunked(products: any[], dryRun: boolean, concurrency: number): Promise<SyncResult[]> {
    const results: SyncResult[] = [];

    for (let i = 0; i < products.length; i += concurrency) {
      const chunk = products.slice(i, i + concurrency);
      const settled = await Promise.allSettled(chunk.map((p) => this.syncOne(p.productId, dryRun)));

      for (const s of settled) {
        results.push(
          s.status === 'fulfilled'
            ? s.value
            : { status: 'FAILED', productId: 'unknown', message: (s as any).reason?.message },
        );
      }
    }

    return results;
  }

  private async syncOne(gineeProductId: string, dryRun: boolean): Promise<SyncResult> {
    if (dryRun) {
      return { status: 'SKIPPED', productId: gineeProductId, message: 'Dry run' };
    }

    try {
      // skipImageDownload=true: images are large and will serialize the whole sync.
      // Schedule a separate image-download job after bulk sync completes.
      await this.gineeProductService.pullProductFromGinee(gineeProductId, true);
      return { status: 'SUCCESS', productId: gineeProductId };
    } catch (error: any) {
      // Log each individual failure to DB
      await this.prisma.gineeSyncLog.create({
        data: {
          type: 'pull_product',                         // ✅ Valid GineeLogType (sync_all doesn't exist in enum)
          status: 'failed',                             // ✅ Valid GineeLogStatus
          errorMessage: error.message,
          payloadSent: { productId: gineeProductId },
        },
      }).catch(() => null);

      return { status: 'FAILED', productId: gineeProductId, message: error.message };
    }
  }

  private async saveSummaryLog(result: SyncAllResult): Promise<void> {
    await this.prisma.gineeSyncLog.create({
      data: {
        type: 'pull_product',                           // ✅ Valid GineeLogType
        status: result.failed === 0 ? 'success' : 'failed', // ✅ Valid GineeLogStatus (no 'completed'/'partial')
        errorMessage: null,
        payloadSent: result as any,
      },
    }).catch((err) => this.logger.warn(`[SyncAll] Failed to write summary log: ${err.message}`));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
