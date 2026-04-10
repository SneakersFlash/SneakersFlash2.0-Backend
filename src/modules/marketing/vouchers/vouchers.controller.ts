import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards, Request, BadRequestException } from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { AuthGuard } from 'src/modules/auth/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Role } from '@prisma/client';
import { Roles } from 'src/common/decorators/roles.decorator';
import { CreateBulkVoucherDto } from './dto/create-bulk-voucher.dto';

@Controller('vouchers')
export class VouchersController {
  constructor(private readonly vouchersService: VouchersService) { }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Post()
  create(@Body() createVoucherDto: CreateVoucherDto) {
    return this.vouchersService.create(createVoucherDto);
  }

  // List Semua Voucher (Admin)
  @UseGuards(AuthGuard)
  @Get()
  findAll(
    @Request() req,
    @Query('activeOnly') activeOnly?: string
  ) {
    const isRequestingActiveOnly = activeOnly === 'true';
    
    // Ambil ID dari token (bergantung pada payload JWT Anda)
    const userId = req.user?.userId || req.user?.id || req.user?.sub;

    return this.vouchersService.findAll(isRequestingActiveOnly, userId ? Number(userId) : undefined);
  }

  // Cek Voucher (Public/User) - API ini dipanggil saat user ketik kode di checkout
  // Contoh: GET /vouchers/check?code=DISKON10&amount=100000
  @UseGuards(AuthGuard)
  @Get('check')
  checkValidity(
    @Request() req,
    @Query('code') code: string,
    @Query('amount') amount: string
  ) {
    console.log('User dari JWT:', req.user);

    const userId = req.user.userId || req.user.id || req.user.sub;

    if (!userId) {
      throw new BadRequestException('User ID tidak ditemukan dalam token.');
    }

    return this.vouchersService.checkVoucherValidity(code, Number(userId), Number(amount));
  }

  // Detail Voucher
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.vouchersService.findOne(+id);
  }

  // Edit Voucher (Admin)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateVoucherDto: UpdateVoucherDto) {
    return this.vouchersService.update(+id, updateVoucherDto);
  }

  // Hapus Voucher (Admin)
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.vouchersService.remove(+id);
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Post('bulk')
  createBulk(@Body() dto: CreateBulkVoucherDto) {
    return this.vouchersService.createBulk(dto);
  }

  @UseGuards(AuthGuard)
  @Post('claim')
  async claimVoucher(
    @Request() req,
    @Body('voucherId') voucherId: string
  ) {
    // Ambil ID dari token JWT
    const userId = req.user?.userId || req.user?.id || req.user?.sub;

    if (!userId) {
      throw new BadRequestException('User ID tidak ditemukan dalam token.');
    }

    if (!voucherId) {
      throw new BadRequestException('Field voucherId wajib dikirimkan');
    }

    return this.vouchersService.claimVoucher(Number(userId), voucherId);
  }
}