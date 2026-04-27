import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Query } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { SyncProductsService } from './sync-products.service';
import { ProductQueryDto } from './dto/product-query.dto';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly syncService: SyncProductsService,
    private prisma: PrismaService 
  ) { }

  @Post()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin) // Satpam Admin
  create(@Body() createProductDto: CreateProductDto) {
    return this.productsService.create(createProductDto);
  }

  // NestJS — products.controller.ts
  @Get('sitemap')
  async getSitemapSlugs() {
    return this.prisma.product.findMany({
      where: { isActive: true },
      select: { slug: true, updatedAt: true }, // hanya 2 field
    });
}

  @Get()
  findAll(@Query() query: ProductQueryDto) { // Public (Bisa dilihat customer)
    return this.productsService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) { // Public
    return this.productsService.findOne(+id);
  }

  @Get('slug/:slug')
  findBySlug(@Param('slug') slug: string) { // Public
    return this.productsService.findBySlug(slug);
  }

  @Patch(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  update(@Param('id') id: string, @Body() updateProductDto: UpdateProductDto) {
    return this.productsService.update(+id, updateProductDto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  remove(@Param('id') id: string) {
    return this.productsService.remove(+id);
  }

  @Post('sync/google-sheet')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  async syncProducts() {
    return this.syncService.syncFromGoogleSheet();
  }
}