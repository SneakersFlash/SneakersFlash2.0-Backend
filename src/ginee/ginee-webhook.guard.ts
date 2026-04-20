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

    const method = request.method.toUpperCase(); 
    const path = request.path;                   
    
    const signString = `${method}$${path}$`;

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(signString)
      .digest('base64');

    if (signature !== expectedSignature) {
      this.logger.warn('[GineeWebhookGuard] Invalid webhook signature — request rejected');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return true; 
  }
}