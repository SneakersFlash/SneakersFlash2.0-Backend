import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { SkipThrottle } from '@nestjs/throttler';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
  
  @SkipThrottle() // Memastikan endpoint ini kebal dari rate limit
  @Get('health')
  checkHealth() {
    return {
      status: 'ok',
      message: 'SneakersFlash API is running gracefully 🚀',
      timestamp: new Date().toISOString(),
    };
  }
}
