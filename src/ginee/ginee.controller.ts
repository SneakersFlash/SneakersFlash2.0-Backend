import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { GineeProductService } from './services/ginee-product.service';
import { GineeOrderService } from './services/ginee-order.service';
import { GineeWebhookGuard } from './ginee-webhook.guard';
import type {
  GineeStockWebhookPayload,
  GineeProductWebhookPayload,
  GineeOrderWebhookPayload,
} from './ginee.types';
import { GineeLogStatus, GineeLogType } from '@prisma/client';
import { GineeLogService } from './services/ginee-log.service';
import { NotificationsService } from 'src/modules/notifications/notifications.service';

@ApiTags('Ginee Integration')
@Controller('ginee')
export class GineeController {
  private readonly logger = new Logger(GineeController.name);

  constructor(
    private readonly gineeProductService: GineeProductService,
    private readonly gineeOrderService: GineeOrderService,
    private readonly gineeLogService: GineeLogService,
    private readonly notificationsService: NotificationsService,
    @InjectQueue('ginee-queue') private readonly gineeQueue: Queue,
    @InjectQueue('ginee-sync-all-queue') private readonly syncAllQueue: Queue,
  ) {}

  @Get('logs')
  @ApiOperation({ summary: 'Get Ginee sync logs with pagination and filtering' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  @ApiQuery({ name: 'type', required: false, enum: GineeLogType, description: 'Filter by log type' })
  @ApiQuery({ name: 'status', required: false, enum: GineeLogStatus, description: 'Filter by log status' })
  async getLogs(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('type') type?: GineeLogType,
    @Query('status') status?: GineeLogStatus,
  ) {
    return this.gineeLogService.getLogs({
      page,
      limit,
      type,
      status,
    });
  }
  
  // ─────────────────────────────────────────────────────────────────────────────
  // WEBHOOKS  (protected by signature guard)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Ginee calls this when inventory changes (e.g. sale on another channel).
   */
  @Post('webhook/stock-update')
  @UseGuards(GineeWebhookGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook: stock updated by Ginee' })
  async handleStockWebhook(@Body() payload: GineeStockWebhookPayload) {
    this.logger.log(`[Webhook] stock_updated — SKU: ${payload.data?.sku}, eventId: ${payload.eventId}`);

    await this.gineeProductService.updateStockFromWebhook(
      payload.data.sku,
      payload.data.availableStock,
      payload.eventId,
    );

    return { status: 'SUCCESS' };
  }

  /**
   * Ginee calls this when a master product is created or updated on Ginee side.
   */
  @Post('webhook/product-update')
  @UseGuards(GineeWebhookGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook: product updated by Ginee' })
  async handleProductWebhook(@Body() payload: GineeProductWebhookPayload) {
    this.logger.log(`[Webhook] product_updated — productId: ${payload.data?.productId}, eventId: ${payload.eventId}`);

    // Queue a pull-product job so the webhook returns fast
    await this.gineeQueue.add(
      'pull-product',
      { gineeProductId: payload.data.productId },
      { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
    );

    return { status: 'SUCCESS' };
  }

  /**
   * Ginee calls this on order lifecycle changes.
   */
  @Post('webhook/order')
  @UseGuards(GineeWebhookGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook: order status changed' })
  async handleOrderWebhook(@Body() payload: any) { // Ubah tipe menjadi any sementara agar tidak bentrok
    
    // 1. FITUR CCTV: Cetak semua data asli yang masuk dari Ginee ke log PM2
    this.logger.log(`[Webhook CCTV] Payload Ginee Masuk: ${JSON.stringify(payload)}`);

    // 2. SABUK PENGAMAN: Jika Ginee hanya tes koneksi atau payload data tidak ada, jangan dilanjut!
    if (!payload || !payload.data) {
      this.logger.warn(`[Webhook] Payload tidak memiliki properti 'data'. Mengabaikan eksekusi.`);
      return { status: 'SUCCESS', message: 'Ignored: No data property' }; // Tetap balas 200 OK ke Ginee
    }

    this.logger.log(
      `[Webhook] order_updated — orderId: ${payload.data.orderId}, status: ${payload.data.orderStatus}, eventId: ${payload.eventId}`,
    );

    // 3. Adjust local stock (Kode Asli)
    await this.gineeProductService.handleOrderWebhook(
      payload.data.orderId,
      payload.data.orderStatus,
      payload.data.items,
      payload.eventId,
    );

    // 4. Tembak Notifikasi ke Telegram via Queue (Kode Baru)
    const triggerStatuses = ['UNPAID', 'PAID', 'READY_TO_SHIP'];
    if (triggerStatuses.includes(payload.data.orderStatus)) {
        await this.gineeQueue.add(
            'send-telegram-alert',
            {
                orderId: payload.data.orderId,
                status: payload.data.orderStatus,
                items: payload.data.items
            },
            { attempts: 3, backoff: { type: 'exponential', delay: 2000 } } 
        );
    }

    // 5. Sync full order record in background (Kode Asli)
    await this.gineeQueue.add(
      'sync-order',
      { gineeOrderId: payload.data.orderId },
      { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
    );

    return { status: 'SUCCESS' };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MANUAL SYNC TRIGGERS (internal / admin only — add AuthGuard as needed)
  // ─────────────────────────────────────────────────────────────────────────────

  @Post('sync/push-product')
  @ApiOperation({ summary: 'Queue: push local product to Ginee' })
  async manualPushProduct(@Body('productId') productId: number) {
    if (!productId) {
      // Throw NestJS HTTP exception, not raw Error
      const { BadRequestException } = await import('@nestjs/common');
      throw new BadRequestException('productId is required');
    }

    await this.gineeQueue.add(
      'push-product',
      { productId },
      { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
    );

    return { message: 'Push product task queued', productId };
  }

  @Post('sync/pull-product')
  @ApiOperation({ summary: 'Queue: pull Ginee product to local DB' })
  async manualPullProduct(@Body('gineeProductId') gineeProductId: string) {
    if (!gineeProductId) {
      const { BadRequestException } = await import('@nestjs/common');
      throw new BadRequestException('gineeProductId is required');
    }

    await this.gineeQueue.add(
      'pull-product',
      { gineeProductId },
      { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
    );

    return { message: 'Pull product task queued', gineeProductId };
  }

  @Post('sync/all')
  @ApiOperation({ summary: 'Queue: bulk sync all Ginee products → local DB' })
  async syncAllProducts(@Body('dryRun') dryRun = false) {
    // Check if a sync is already running to prevent double-queueing
    const activeJobs = await this.syncAllQueue.getActive();
    const waitingJobs = await this.syncAllQueue.getWaiting();

    if (activeJobs.length > 0 || waitingJobs.length > 0) {
      return {
        success: false,
        message: 'A sync-all job is already running or queued. Please wait.',
      };
    }

    await this.syncAllQueue.add(
      'sync-all-products',
      { dryRun },
      {
        removeOnComplete: 5,   // Keep last 5 completed jobs for visibility
        removeOnFail: 10,      // Keep last 10 failed for debugging
        jobId: `sync-all-${Date.now()}`, // Unique ID to prevent duplicates
      },
    );

    return {
      success: true,
      message: dryRun
        ? 'Dry run sync queued — no data will be changed'
        : 'Sync All job queued and running in background',
    };
  }
}
