import { Controller, Get, Post, Body, Param } from '@nestjs/common';
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
      {
        itemValue: dto.itemValue, // Kirim ke service
        isCod: dto.isCod          // Kirim ke service
      }
    );
  }
}