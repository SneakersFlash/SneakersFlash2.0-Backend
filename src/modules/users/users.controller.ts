import { Controller, Get, Patch, Post, Delete, Body, Param, UseGuards, Request } from '@nestjs/common';
import { UsersService } from './users.service';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Role } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateUserAddressDto } from './dto/create-user-address.dto';
import { UpdateUserAddressDto } from './dto/update-user-address.dto';

@Controller('users')
@UseGuards(AuthGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ==========================================
  // 1. CUSTOMER PROFILE ROUTES
  // ==========================================

  @Get('me')
  @Roles(Role.customer, Role.admin)
  getMyProfile(@Request() req) {
    return this.usersService.findMyProfile(req.user.sub);
  }

  @Patch('me')
  @Roles(Role.customer, Role.admin)
  updateMyProfile(@Request() req, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.updateMyProfile(req.user.sub, updateUserDto);
  }

  // ==========================================
  // 2. CUSTOMER ADDRESS ROUTES
  // ==========================================

  @Get('me/addresses')
  @Roles(Role.customer, Role.admin)
  getMyAddresses(@Request() req) {
    return this.usersService.getMyAddresses(req.user.sub);
  }

  @Post('me/addresses')
  @Roles(Role.customer, Role.admin)
  addMyAddress(@Request() req, @Body() createAddressDto: CreateUserAddressDto) {
    return this.usersService.addMyAddress(req.user.sub, createAddressDto);
  }

  @Patch('me/addresses/:addressId')
  @Roles(Role.customer, Role.admin)
  updateMyAddress(
    @Request() req, 
    @Param('addressId') addressId: string, 
    @Body() updateAddressDto: UpdateUserAddressDto
  ) {
    return this.usersService.updateMyAddress(req.user.sub, +addressId, updateAddressDto);
  }

  @Delete('me/addresses/:addressId')
  @Roles(Role.customer, Role.admin)
  deleteMyAddress(@Request() req, @Param('addressId') addressId: string) {
    return this.usersService.deleteMyAddress(req.user.sub, +addressId);
  }

  // ==========================================
  // 3. ADMIN ROUTES
  // ==========================================

  @Get()
  @Roles(Role.admin)
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  @Roles(Role.admin)
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(+id);
  }
}