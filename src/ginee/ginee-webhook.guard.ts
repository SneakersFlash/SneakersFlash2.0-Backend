import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import type { Request } from 'express';

@Injectable()
export class GineeWebhookGuard implements CanActivate {
  private readonly logger = new Logger(GineeWebhookGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const secret = this.configService.get<string>('GINEE_WEBHOOK_SECRET');

    if (!secret) {
      const isDev = this.configService.get<string>('NODE_ENV') !== 'production';
      if (isDev) return true;
      throw new UnauthorizedException('Webhook secret not configured');
    }

    const signature = request.headers['authorization'] as string;
    if (!signature) {
      this.logger.warn('[GineeWebhookGuard] Missing authorization header');
      throw new UnauthorizedException('Missing webhook signature');
    }

    // 💡 PENEMUAN BESAR: Ginee Webhook ternyata menggunakan rumus API, 
    // yaitu mengenkripsi METHOD dan PATH, bukan Body!
    const method = request.method.toUpperCase(); // Menghasilkan "POST"
    const path = request.path;                   // Menghasilkan "/ginee/webhook/order"
    
    // Rumus rahasia Ginee: METHOD$PATH$
    const signString = `${method}$${path}$`;

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(signString)
      .digest('base64');

    // --- CCTV ---
    console.log('--- DEBUG WEBHOOK SIGNATURE ---');
    console.log('Header Asli Ginee   :', signature);
    console.log('String yg Dihitung  :', signString);
    console.log('Hash Buatan Lokal   :', expectedSignature);
    console.log('-------------------------------');

    if (signature !== expectedSignature) {
      this.logger.warn('[GineeWebhookGuard] Invalid webhook signature — request rejected');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return true; // Lolos 100%!
  }
}