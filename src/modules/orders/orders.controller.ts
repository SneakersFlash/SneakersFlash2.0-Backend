import { Controller, Get, Post, Body, UseGuards, Request } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { AuthGuard } from '../auth/auth.guard';

@Controller('orders')
@UseGuards(AuthGuard) // Wajib Login
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('checkout')
  checkout(@Request() req, @Body() createOrderDto: CreateOrderDto) {
    return this.ordersService.checkout(+req.user.sub, createOrderDto);
  }

  @Get('my-orders')
  getMyOrders(@Request() req) {
    return this.ordersService.getMyOrders(+req.user.sub);
  }
}