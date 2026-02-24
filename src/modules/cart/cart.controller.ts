import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Request } from '@nestjs/common';
import { CartService } from './cart.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart.dto';
import { AuthGuard } from '../auth/auth.guard';

@Controller('cart')
@UseGuards(AuthGuard) // Wajib Login
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Post()
  addToCart(@Request() req, @Body() addToCartDto: AddToCartDto) {
    // req.user.sub adalah ID User dari Token JWT
    return this.cartService.addToCart(+req.user.sub, addToCartDto);
  }

  @Get()
  getMyCart(@Request() req) {
    return this.cartService.getMyCart(+req.user.sub);
  }

  @Patch('item/:id')
  updateItem(@Request() req, @Param('id') id: string, @Body() dto: UpdateCartItemDto) {
    return this.cartService.updateItem(+req.user.sub, +id, dto);
  }

  @Delete('item/:id')
  removeItem(@Request() req, @Param('id') id: string) {
    return this.cartService.removeItem(+req.user.sub, +id);
  }
}