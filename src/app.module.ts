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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}