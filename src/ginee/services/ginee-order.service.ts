import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { GineeClientService } from './ginee-client.service';

@Injectable()
export class GineeOrderService {
  private readonly logger = new Logger(GineeOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gineeClient: GineeClientService,
  ) {}

  async syncOrderFromGinee(gineeOrderId: string): Promise<void> {
    this.logger.log(`[Order] Syncing order ${gineeOrderId} from Ginee`);

    try {
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 1);
      
      const startDate = new Date();
      startDate.setDate(endDate.getDate() - 2);

      const lastUpdateSince = startDate.toISOString().split('.')[0] + 'Z';
      const lastUpdateTo = endDate.toISOString().split('.')[0] + 'Z';

      const response = await this.gineeClient.post('/order/v2/list-order', { 
        lastUpdateSince: lastUpdateSince,
        lastUpdateTo: lastUpdateTo,
        size: 100 
      });

      const responseData = response?.data;
      const orderList = responseData?.content || [];
      
      const orderRaw = orderList.find((order: any) => order.orderId === gineeOrderId);

      this.logger.log(`[CCTV V2] Data Order Ditemukan: ${JSON.stringify(orderRaw || 'TIDAK ADA DALAM RANGE WAKTU')}`);

      if (!orderRaw) {
        this.logger.warn(`[Order] No data returned for order ${gineeOrderId}`);
        return;
      }

      const statusMap: Record<string, string> = {
        UNPAID:          'waiting_payment',
        PENDING_PAYMENT: 'waiting_payment',
        PAID:            'paid',
        READY_TO_SHIP:   'processing',
        SHIPPED:         'shipped',
        DELIVERED:       'delivered',
        COMPLETED:       'completed',
        CANCELLED:       'cancelled',
      };

      const localStatus = (statusMap[orderRaw.orderStatus] ?? 'pending') as any;

      const existingOrder = await this.prisma.order.findFirst({
        where: { gineeOrderId },
      });

      if (existingOrder) {
        await this.prisma.order.update({
          where: { id: existingOrder.id },
          data: { status: localStatus, updatedAt: new Date() },
        });
        this.logger.log(`[Order] Updated order ${gineeOrderId} → status: ${localStatus}`);
      } else {
        this.logger.warn(`[Order] Order ${gineeOrderId} not found in local DB.`);
      }
      
    } catch (error: any) {
      this.logger.error(`[Order] Sync gagal: ${error.message}`);
    }
  }

  async getOrderDetails(gineeOrderId: string): Promise<any> {
    try {
      const response = await this.gineeClient.post('/order/v1/batch-get', { 
        orderIds: [gineeOrderId] 
      });
      
      return response?.data?.[0] || null;
    } catch (error: any) {
      this.logger.error(`[Order] Gagal menarik detail pesanan: ${error.message}`);
      return null;
    }
  }
}
