import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { EventsService } from './events.service';
import { AuthGuard } from 'src/modules/auth/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Role } from '@prisma/client';
import { Roles } from 'src/common/decorators/roles.decorator';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto'; // Pastikan ini di-import

@Controller('marketing/events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  // ===================================
  // PUBLIC FEATURES (Frontend User)
  // ===================================

  // Public: List Event Aktif (Homepage)
  @Get('active')
  findActive() {
    return this.eventsService.findActiveEvents();
  }

  // Public: Detail Event (Halaman Promo)
  @Get('slug/:slug') // Ubah sedikit path-nya untuk menghindari bentrok dengan /admin/all
  findOne(@Param('slug') slug: string) {
    return this.eventsService.findBySlug(slug);
  }

  // ===================================
  // ADMIN FEATURES
  // ===================================

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Get('admin/all')
  findAllAdmin() {
    return this.eventsService.findAllAdmin();
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Post()
  create(@Body() dto: CreateEventDto) {
    return this.eventsService.create(dto);
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateEventDto) {
    return this.eventsService.update(+id, dto);
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.eventsService.remove(+id);
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Post(':id/products')
  addProduct(
    @Param('id') id: string,
    @Body() body: { productId: number; price: number; quota: number },
  ) {
    return this.eventsService.addProductToEvent(
      +id,
      body.productId,
      body.price,
      body.quota,
    );
  }
  
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Post('admin/:id/sync-sheet')
  async syncFromSheet(
    @Param('id') id: string,
    @Body() body: { sheetUrl: string; sheetName?: string },
  ) {
    if (!body.sheetUrl) {
      throw new BadRequestException('URL Spreadsheet (sheetUrl) wajib diisi!');
    }
    // Jika sheetName tidak dikirim, default ke 'Sheet1'
    return this.eventsService.syncEventProductsFromSheet(
      +id,
      body.sheetUrl,
      body.sheetName || 'Sheet1',
    );
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Get('admin/:id/products')
  getEventProductsAdmin(@Param('id') id: string) {
    return this.eventsService.findEventProductsAdmin(+id);
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Delete('admin/:eventId/products/:variantId')
  removeEventProduct(
    @Param('eventId') eventId: string, 
    @Param('variantId') variantId: string
  ) {
    return this.eventsService.removeEventProduct(+eventId, +variantId);
  }
}