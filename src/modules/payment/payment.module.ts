import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { LogisticsModule } from '../logistics/logistics.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [LogisticsModule, NotificationsModule], // <-- TAMBAHKAN DISINI
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService] // <--- WAJIB TAMBAHKAN INI!
})
export class PaymentModule { }
