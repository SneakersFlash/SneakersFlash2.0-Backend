import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { AuthGuard } from 'src/modules/auth/auth.guard';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.admin)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  getStats() {
    return this.dashboardService.getStats();
  }

  @Get('revenue-chart')
  getRevenueChart(@Query('days') days?: string) {
    const parsedDays = days ? parseInt(days, 10) : 7;
    const clampedDays = Math.min(Math.max(parsedDays, 1), 30);
    return this.dashboardService.getRevenueChart(clampedDays);
  }

  @Get('order-status')
  getOrderStatusDistribution() {
    return this.dashboardService.getOrderStatusDistribution();
  }
}
