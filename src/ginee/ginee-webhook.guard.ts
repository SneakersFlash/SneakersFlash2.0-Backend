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

/**
 * Guard to verify incoming Ginee webhook signatures.
 * Apply with @UseGuards(GineeWebhookGuard) on webhook endpoints.
 *
 * Ginee signs the raw body with HMAC-SHA256 using your webhook secret.
 * Header: X-Ginee-Signature = sha256=<hex>
 */
@Injectable()
export class GineeWebhookGuard implements CanActivate {
  private readonly logger = new Logger(GineeWebhookGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const secret = this.configService.get<string>('GINEE_WEBHOOK_SECRET');

    // If no secret is configured, block all webhook calls in production.
    if (!secret) {
      const isDev = this.configService.get<string>('NODE_ENV') !== 'production';
      if (isDev) {
        this.logger.warn(
          '[GineeWebhookGuard] GINEE_WEBHOOK_SECRET not set — skipping verification in dev mode.',
        );
        return true;
      }
      this.logger.error('[GineeWebhookGuard] GINEE_WEBHOOK_SECRET is not configured!');
      throw new UnauthorizedException('Webhook secret not configured');
    }

    const secretKey = process.env.GINEE_WEBHOOK_SECRET;
    const signature = request.headers['authorization'] as string;
    
    const payloadString = JSON.stringify(request.body);

    const expectedSignature = crypto
      .createHmac('sha256', secretKey || '')
      .update(payloadString)
      .digest('base64');

    console.log('--- DEBUG WEBHOOK SIGNATURE ---');
    console.log('Header Asli Ginee   :', signature);
    console.log('Hash Buatan Lokal   :', expectedSignature);
    console.log('-------------------------------');

    if (signature !== expectedSignature) {
      this.logger.warn('[GineeWebhookGuard] Invalid webhook signature — request rejected');
      throw new UnauthorizedException('Missing webhook signature');
    }

    const rawBody: Buffer = (request as any).rawBody;
    if (!rawBody) {
      this.logger.error('[GineeWebhookGuard] rawBody not found');
      throw new UnauthorizedException('Cannot verify signature: raw body unavailable');
    }

    // 2. Ginee melakukan enkripsi dengan output 'base64', bukan 'hex'
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );

    if (!isValid) {
      this.logger.warn('[GineeWebhookGuard] Invalid webhook signature — request rejected');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return true;
  }
}