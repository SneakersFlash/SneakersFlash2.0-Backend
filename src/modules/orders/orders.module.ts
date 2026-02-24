import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { PaymentModule } from '../payment/payment.module';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService],
  imports: [PaymentModule]
})
export class OrdersModule {}
