import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { WishlistService } from './wishlist.service';
import { AddWishlistDto } from './dto/add-wishlist.dto';
import { WishlistQueryDto } from './dto/wishlist-query.dto';
import { AuthGuard } from '../auth/auth.guard';

@Controller('wishlists')
@UseGuards(AuthGuard) // Wajib Login
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  // GET /wishlists?page=1&limit=20
  @Get()
  findAll(@Request() req, @Query() query: WishlistQueryDto) {
    return this.wishlistService.findAll(+req.user.sub, query);
  }

  // GET /wishlists/check/:productId?variantId=1
  @Get('check/:productId')
  check(
    @Request() req,
    @Param('productId') productId: string,
    @Query('variantId') variantId?: string,
  ) {
    return this.wishlistService.check(
      +req.user.sub,
      +productId,
      variantId ? +variantId : undefined,
    );
  }

  // POST /wishlists
  @Post()
  add(@Request() req, @Body() dto: AddWishlistDto) {
    return this.wishlistService.add(+req.user.sub, dto);
  }

  // DELETE /wishlists/:id
  @Delete(':id')
  remove(@Request() req, @Param('id') id: string) {
    return this.wishlistService.remove(+req.user.sub, +id);
  }

  // DELETE /wishlists
  @Delete()
  clear(@Request() req) {
    return this.wishlistService.clear(+req.user.sub);
  }
}