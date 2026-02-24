import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { LogisticsModule } from '../logistics/logistics.module';

@Module({
  imports: [LogisticsModule], // <-- TAMBAHKAN DISINI
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService] // <--- WAJIB TAMBAHKAN INI!
})
export class PaymentModule { }
