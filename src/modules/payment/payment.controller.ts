import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { PaymentService } from './payment.service';

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) { }

  @Post('notification')
  @HttpCode(HttpStatus.OK) // Midtrans minta status balasan harus 200 OK
  async handleMidtransNotification(@Body() payload: any) {
    return this.paymentService.handleNotification(payload);
  }
}