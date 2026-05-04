import { Controller, Get, Post, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { LogisticsService } from './logistics.service';
import { CalculateShippingDto } from './dto/create-logistic.dto';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { UsersService } from '../users/users.service';

@Controller('logistics')
export class LogisticsController {
  constructor(
    private readonly logisticsService: LogisticsService,
    private readonly usersService: UsersService,
  ) {}

  @Get('provinces')
  getProvinces() {
    return this.logisticsService.getProvinces();
  }

  @Get('cities/:provinceId')
  getCities(@Param('provinceId') provinceId: string) {
    return this.logisticsService.getCities(+provinceId);
  }

  @Get('districts/:cityId')
  getDistricts(@Param('cityId') cityId: string) {
    return this.logisticsService.getDistricts(+cityId);
  }

  @Get('subdistricts/:districtId')
  getSubDistricts(@Param('districtId') districtId: string) {
    return this.logisticsService.getSubDistricts(+districtId);
  }

  @UseGuards(OptionalAuthGuard)
  @Post('calculate')
  async calculate(@Body() dto: CalculateShippingDto, @Request() req: any) {
    const shippingResult = await this.logisticsService.calculateShippingCost(
      dto.destinationSubdistrictId,
      dto.weightGrams,
      dto.courier,
      dto.itemValue,
      dto.isCod,
      dto.originPinPoint,
      dto.destinationPinPoint
    );

    const userId = req.user?.sub;
    if (!userId) return shippingResult;

    const user = await this.usersService.findMyProfile(+userId);
    return {
      ...shippingResult,
      pointsBalance: Number(user?.pointsBalance ?? 0),
    };
  }

  @Get('label/:orderNo')
  async getShippingLabel(
    @Param('orderNo') orderNo: string,
    @Query('page') page?: string
  ) {
    return this.logisticsService.getShippingLabel(orderNo, page || 'page_5');
  }

  @Get('track/:awb')
  async trackShipment(
    @Param('awb') awb: string,
    @Query('courier') courier: string,
    @Query('last_phone') lastPhone?: string,
  ) {
    return this.logisticsService.trackShipment(awb, courier, lastPhone);
  }
}
