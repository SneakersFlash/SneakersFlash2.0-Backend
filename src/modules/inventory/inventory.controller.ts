import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { CreateInventoryDto } from './dto/create-inventory.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('inventory')
@UseGuards(AuthGuard, RolesGuard) // Satpam: Cek Login & Role
@Roles(Role.admin)                // Hanya Admin
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('adjust')
  adjustStock(@Body() createInventoryDto: CreateInventoryDto) {
    return this.inventoryService.adjustStock(createInventoryDto);
  }

  @Get('history/:variantId')
  getHistory(@Param('variantId') variantId: string) {
    return this.inventoryService.getHistory(+variantId);
  }
}