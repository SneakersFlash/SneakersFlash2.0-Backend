import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { GineeProductService } from './services/ginee-product.service';
import { GineeOrderService } from './services/ginee-order.service';
import { NotificationsService } from 'src/modules/notifications/notifications.service';

@Processor('ginee-queue')
export class GineeProcessor {
  private readonly logger = new Logger(GineeProcessor.name);

  constructor(
    private readonly gineeProductService: GineeProductService,
    private readonly gineeOrderService: GineeOrderService,
    private readonly notificationsService: NotificationsService, 
  ) {}

  @Process('push-product')
  async handlePushProduct(job: Job<{ productId: number }>) {
    this.logger.log(`[Queue] push-product — ID: ${job.data.productId}`);
    const result = await this.gineeProductService.pushProductToGinee(job.data.productId);
    this.logger.log(`[Queue] push-product done — gineeId: ${result.gineeProductId}`);
    return result;
  }

  @Process('pull-product')
  async handlePullProduct(job: Job<{ gineeProductId: string }>) {
    this.logger.log(`[Queue] pull-product — gineeId: ${job.data.gineeProductId}`);
    const result = await this.gineeProductService.pullProductFromGinee(job.data.gineeProductId);
    this.logger.log(`[Queue] pull-product done — ${job.data.gineeProductId}`);
    return result;
  }

  @Process('sync-order')
  async handleSyncOrder(job: Job<{ gineeOrderId: string }>) {
    this.logger.log(`[Queue] sync-order — orderId: ${job.data.gineeOrderId}`);
    await this.gineeOrderService.syncOrderFromGinee(job.data.gineeOrderId);
    this.logger.log(`[Queue] sync-order done — ${job.data.gineeOrderId}`);
  }

  @Process('send-telegram-alert')
  async handleSendTelegramAlert(job: Job<{ orderId: string; status: string; items?: any[] }>) {
    // this.logger.log(`[Queue] send-telegram-alert mulai — orderId: ${job.data.orderId}`);
    
    try {
      if (!this.notificationsService) {
        throw new Error('NotificationsService gagal di-inject!');
      }

      const orderData = await this.gineeOrderService.getOrderDetails(job.data.orderId);
      
      const items = orderData?.items || orderData?.orderItem || orderData?.orderItems || [];
      const channel = orderData?.channel || 'Tidak Diketahui';
      const payAt = orderData?.payAt || orderData?.createAt || '-';
      const externalOrderId = orderData?.externalOrderId || '-';

      await this.notificationsService.sendWarehouseAlert(
        job.data.orderId,
        job.data.status,
        items,
        channel,
        payAt,
        externalOrderId
      );
      
      // this.logger.log(`[Queue] send-telegram-alert SELESAI — orderId: ${job.data.orderId}`);
    } catch (error: any) {
      this.logger.error(`[Queue] ERROR Telegram: ${error.message}`, error.stack);
      throw error; 
    }
  }
}
