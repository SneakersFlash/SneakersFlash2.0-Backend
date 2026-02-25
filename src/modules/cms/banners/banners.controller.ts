import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { BannersService } from './banners.service';
import { CreateBannerDto } from './dto/create-banner.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';
import { BannerPosition, Role } from '@prisma/client';
import { AuthGuard } from 'src/modules/auth/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';

@Controller('banners')
export class BannersController {
  constructor(private readonly bannersService: BannersService) { }

  // ==========================
  // PUBLIC (Frontend)
  // ==========================

  // GET /banners?position=home_top
  @Get()
  findAll(@Query('position') position?: BannerPosition) {
    return this.bannersService.findAll(position);
  }

  // ==========================
  // ADMIN (Management)
  // ==========================

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Get('admin/all')
  findAllAdmin() {
    return this.bannersService.findAllAdmin();
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.bannersService.findOne(+id);
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Post()
  create(@Body() dto: CreateBannerDto) {
    return this.bannersService.create(dto);
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateBannerDto) {
    return this.bannersService.update(+id, dto);
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.bannersService.remove(+id);
  }
}