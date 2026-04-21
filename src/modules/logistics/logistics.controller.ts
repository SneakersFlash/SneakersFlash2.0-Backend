import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { LogisticsService } from './logistics.service';
import { CalculateShippingDto } from './dto/create-logistic.dto';

@Controller('logistics')
export class LogisticsController {
  constructor(private readonly logisticsService: LogisticsService) { }

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

  @Post('calculate')
  async calculate(@Body() dto: CalculateShippingDto) {
    return this.logisticsService.calculateShippingCost(
      dto.destinationSubdistrictId,
      dto.weightGrams,
      dto.courier,
      dto.itemValue,
      dto.isCod,
      dto.originPinPoint,
      dto.destinationPinPoint
    );
  }

  @Get('label/:orderNo')
  async getShippingLabel(
    @Param('orderNo') orderNo: string,
    @Query('page') page?: string
  ) {
    // Ubah fallback dari 'A6' menjadi 'page_5' sesuai Komerce
    return this.logisticsService.getShippingLabel(orderNo, page || 'page_5');
  }
}