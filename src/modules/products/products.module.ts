import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { SyncProductsService } from './sync-products.service';

@Module({
  controllers: [ProductsController],
  providers: [ProductsService, SyncProductsService],
})
export class ProductsModule {}
