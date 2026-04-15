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

    const response = await this.gineeClient.post('/oms/order/list', { orderId: gineeOrderId });
    const orderRaw = response?.data;

    if (!orderRaw) {
      this.logger.warn(`[Order] No data returned for order ${gineeOrderId}`);
      return;
    }

    const statusMap: Record<string, string> = {
      UNPAID:        'waiting_payment',
      PAID:          'paid',
      READY_TO_SHIP: 'processing',
      SHIPPED:       'shipped',
      DELIVERED:     'delivered',
      COMPLETED:     'completed',
      CANCELLED:     'cancelled',
    };

    const localStatus = (statusMap[orderRaw.orderStatus] ?? 'pending') as any;

    // ⚠️  Order.gineeOrderId is NOT @unique in your schema, so we can't use upsert.
    //     We use findFirst + update, or skip if no matching local order exists.
    //
    //     RECOMMENDED FIX: Add @unique to gineeOrderId in schema.prisma:
    //       gineeOrderId String? @unique @map("ginee_order_id")
    //     Then run: npx prisma migrate dev
    //     After that, replace this block with a proper upsert.

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
      // We can't create the order from Ginee alone — too many required fields
      // (userId, orderNumber, shippingRecipientName, etc.) that only exist in your system.
      // Log it and move on.
      this.logger.warn(
        `[Order] Order ${gineeOrderId} not found in local DB — cannot create from webhook alone. ` +
        `This is expected if the order was placed externally on a marketplace.`,
      );
    }
  }
}
