import { Controller, Post, Get, Body, HttpCode, HttpStatus, Query, UseGuards, Res } from '@nestjs/common';
import { type Response } from 'express';
import { PaymentService } from './payment.service';
import { AuthGuard } from 'src/modules/auth/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) { }

  @Post('notification')
  @HttpCode(HttpStatus.OK)
  async handleMidtransNotification(@Body() payload: any) {
    return this.paymentService.handleNotification(payload);
  }

  // Export harus di atas GET admin/logs agar tidak bentrok jika ada route dinamis di masa depan
  @Get('admin/logs/export')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  async exportPaymentLogs(
    @Query('search')      search?: string,
    @Query('status')      status?: string,
    @Query('paymentType') paymentType?: string,
    @Query('dateFrom')    dateFrom?: string,
    @Query('dateTo')      dateTo?: string,
    @Res() res?: Response,
  ) {
    const { csv, filename } = await this.paymentService.exportPaymentLogs({
      search,
      status,
      paymentType,
      dateFrom,
      dateTo,
    });

    res?.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res?.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res?.send(csv);
  }

  @Get('admin/logs')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  getPaymentLogs(
    @Query('page')        page?: string,
    @Query('limit')       limit?: string,
    @Query('search')      search?: string,
    @Query('status')      status?: string,
    @Query('paymentType') paymentType?: string,
    @Query('dateFrom')    dateFrom?: string,
    @Query('dateTo')      dateTo?: string,
  ) {
    return this.paymentService.getPaymentLogs({
      page:        page  ? parseInt(page,  10) : undefined,
      limit:       limit ? parseInt(limit, 10) : undefined,
      search,
      status,
      paymentType,
      dateFrom,
      dateTo,
    });
  }
}