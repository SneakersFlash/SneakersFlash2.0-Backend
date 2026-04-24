// src/common/guards/throttler.config.ts
// Rate Limiting dengan ThrottlerModule (anti brute force)

import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

// Custom throttler dengan Redis storage (untuk distributed rate limiting)
export const throttlerModuleConfig = ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    throttlers: [
      {
        name: 'global',
        ttl: 60000,    // 1 menit
        limit: 100,    // 100 request per menit per IP
      },
    ],
    storage: new ThrottlerStorageRedisService(
      new Redis({
        host: config.get('REDIS_HOST', 'redis'),
        port: config.get<number>('REDIS_PORT', 6379),
        password: config.get('REDIS_PASSWORD'),
        enableOfflineQueue: false,
        maxRetriesPerRequest: 3,
        lazyConnect: true,
        tls: config.get('REDIS_TLS') === 'true' ? {} : undefined,
      }),
    ),
    errorMessage: 'Too many requests. Please try again later.',
    skipIf: (context) => {
      // Skip health check endpoint
      const request = context.switchToHttp().getRequest();
      return request.path === '/health';
    },
  }),
});

// Global throttler guard
export const throttlerGuardProvider = {
  provide: APP_GUARD,
  useClass: ThrottlerGuard,
};

// ============================================================
// Decorator untuk custom rate limit per endpoint
// Usage: @Throttle({ auth: { limit: 5, ttl: 60000 } })
// ============================================================

// Custom decorators untuk endpoint spesifik
import { Throttle, SkipThrottle } from '@nestjs/throttler';

// Auth endpoints: 5 attempts per minute
export const AuthThrottle = () =>
  Throttle({ default: { limit: 5, ttl: 60000 } });

// Payment endpoints: 10 per minute
export const PaymentThrottle = () =>
  Throttle({ default: { limit: 10, ttl: 60000 } });

// Public read: 200 per minute
export const PublicReadThrottle = () =>
  Throttle({ default: { limit: 200, ttl: 60000 } });

export { SkipThrottle };
