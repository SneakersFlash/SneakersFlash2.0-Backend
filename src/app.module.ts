import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { MediaModule } from './modules/media/media.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { CacheModule } from '@nestjs/cache-manager'; // Import Cache
import { BullModule } from '@nestjs/bull'; // Import Queue
// ... import module lainnya tetap sama ...
import { BrandsModule } from './modules/brands/brands.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { ProductsModule } from './modules/products/products.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { CartModule } from './modules/cart/cart.module';
import { OrdersModule } from './modules/orders/orders.module';
import { LogisticsModule } from './modules/logistics/logistics.module';
import { PaymentModule } from './modules/payment/payment.module';
import { VouchersModule } from './modules/marketing/vouchers/vouchers.module';
import { EventsModule } from './modules/marketing/events/events.module';
import { BannersModule } from './modules/cms/banners/banners.module';
import { BlogModule } from './modules/cms/blog/blog.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { GineeModule } from './ginee/ginee.module';
import { WishlistModule } from './modules/wishlist/wishlist.module';
import { CampaignsModule } from './modules/marketing/campaigns/campaigns.module';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { redisStore } from 'cache-manager-redis-store';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    
    // 1. Konfigurasi Redis untuk Caching
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        ttl: 60000, 
        store: await redisStore({ 
          url: configService.get<string>('REDIS_URL') || `redis://${configService.get('REDIS_HOST') || 'localhost'}:${configService.get('REDIS_PORT') || '6379'}` 
        })
      }),
      inject: [ConfigService],
    }),

    // 2. Konfigurasi Redis untuk Queue (Bull)
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        redis: {
          host: configService.get('REDIS_HOST') || 'localhost',
          port: parseInt(configService.get('REDIS_PORT') || '6379') || 6379,
          password: configService.get('REDIS_PASSWORD') || undefined,
        },
      }),
      inject: [ConfigService],
    }),

    ThrottlerModule.forRoot([{
      name: 'short',
      ttl: 60000, // Waktu dalam milidetik (60 detik / 1 Menit)
      limit: 50,  // Maksimal 50 request per menit secara global
    }]),

    PrismaModule,
    AuthModule, UsersModule, MediaModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'),
      serveRoot: '/uploads',
    }),
    BrandsModule,
    CategoriesModule,
    ProductsModule,
    InventoryModule,
    CartModule,
    OrdersModule,
    LogisticsModule,
    PaymentModule,
    VouchersModule,
    EventsModule,
    BannersModule,
    BlogModule,
    NotificationsModule,
    GineeModule,
    WishlistModule,
    CampaignsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard
    }
  ],
})
export class AppModule {}