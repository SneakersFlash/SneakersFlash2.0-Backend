import { Controller, Get, Post, Body, UseGuards, Request, Query, Param, Patch, Res } from '@nestjs/common';
import { type Response } from 'express';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('orders')
@UseGuards(AuthGuard) // Wajib Login
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('checkout')
  @UseGuards(AuthGuard, RolesGuard)
  checkout(@Request() req, @Body() createOrderDto: CreateOrderDto) {
    return this.ordersService.checkout(+req.user.sub, createOrderDto);
  }

  @Get('my-orders')
  @UseGuards(AuthGuard, RolesGuard)
  getMyOrders(@Request() req) {
    return this.ordersService.getMyOrders(+req.user.sub);
  }

  @Get('admin')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  getAllOrdersForAdmin(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ) {
    return this.ordersService.findAllForAdmin({
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 10,
      status,
      search,
      sortBy,
      sortOrder
    });
  }

  // Export harus di atas @Get(':id') agar route 'export' tidak tertangkap sebagai :id
  @Get('admin/export')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  async exportOrders(
    @Query('status')   status?: string,
    @Query('search')   search?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo')   dateTo?: string,
    @Res() res?: Response,
  ) {
    const { csv, filename } = await this.ordersService.exportOrders({
      status,
      search,
      dateFrom,
      dateTo,
    });

    res?.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res?.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res?.send(csv);
  }

  // Endpoint untuk Get Detail Order (Sesuai panggilan frontend: api.get(`/orders/${order.id}`))
  @Get(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin, Role.customer)
  getOrderById(@Request() req, @Param('id') id: string) {
    return this.ordersService.findOne(id, req.user.sub, req.user.role);
  }

  // Endpoint untuk Update Status & Batal (Sesuai panggilan frontend: api.patch(`/orders/${orderId}/status`))
  @Patch(':id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  updateOrderStatus(
    @Param('id') id: string,
    @Body('status') status: string,
    @Body('trackingNumber') trackingNumber?: string
  ) {
    return this.ordersService.updateOrderStatus(id, status, trackingNumber);
  }

  @Post(':id/komerce-pickup')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  requestKomercePickup(@Param('id') id: string) {
    return this.ordersService.processKomerceShipment(id);
  }

  @Patch(':id/cancel')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin) // Pastikan hanya role customer yang bisa akses
  cancelOrderClient(@Param('id') id: string, @Request() req) {
    // req.user.sub adalah User ID yang didapat dari token JWT
    return this.ordersService.cancelOrderClient(id, +req.user.sub);
  }
}