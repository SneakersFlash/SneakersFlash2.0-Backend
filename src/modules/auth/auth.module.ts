import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthGuard } from './auth.guard';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      global: true, // Agar tidak perlu import di module lain
      secret: process.env.JWT_SECRET || 'rahasia_negara_api', // Nanti pindah ke .env
      signOptions: { expiresIn: '1d' }, // Token valid 1 hari
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}