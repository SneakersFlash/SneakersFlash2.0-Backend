import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config'; // Jangan lupa install @nestjs/config
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module'; // Ini otomatis ada kalau sudah generate Auth
import { UsersModule } from './modules/users/users.module';
import { MediaModule } from './modules/media/media.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
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
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // Load .env
    PrismaModule, // <--- Load Database Global
    AuthModule, UsersModule, MediaModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'), // Arahkan ke folder uploads di root
      serveRoot: '/uploads', // Prefix URL (jadi aksesnya via localhost:3000/uploads/...)
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}