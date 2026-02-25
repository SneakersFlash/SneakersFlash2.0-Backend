import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { EventsService } from './events.service';
import { AuthGuard } from 'src/modules/auth/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Role } from '@prisma/client';
import { Roles } from 'src/common/decorators/roles.decorator';
import { CreateEventDto } from './dto/create-event.dto';

@Controller('marketing/events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) { }

  // Public: List Event Aktif (Homepage)
  @Get('active')
  findActive() {
    return this.eventsService.findActiveEvents();
  }

  // Public: Detail Event (Halaman Promo)
  @Get(':slug')
  findOne(@Param('slug') slug: string) {
    return this.eventsService.findBySlug(slug);
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Post()
  create(@Body() dto: CreateEventDto) { // Ganti 'any' dengan DTO nanti
    return this.eventsService.create(dto);
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Post(':id/products')
  addProduct(
    @Param('id') id: string,
    @Body() body: { productId: number; price: number; quota: number }
  ) {
    return this.eventsService.addProductToEvent(+id, body.productId, body.price, body.quota);
  }
}