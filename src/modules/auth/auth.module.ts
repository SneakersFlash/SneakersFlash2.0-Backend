import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthGuard } from './auth.guard';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    // ConfigModule wajib di-import agar ConfigService tersedia di module ini
    ConfigModule,
    PassportModule,
    NotificationsModule,
    // registerAsync memastikan JWT_SECRET dibaca dari .env setelah app fully loaded,
    // bukan saat modul diinisialisasi (menghindari undefined pada process.env)
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1d' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}