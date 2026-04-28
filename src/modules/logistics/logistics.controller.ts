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
    return this.logisticsService.getShippingLabel(orderNo, page || 'page_5');
  }

  /**
   * Tracking resi/AWB pengiriman
   *
   * GET /logistics/track/:awb?courier=jne&last_phone=12345
   *
   * @param awb            - Nomor resi (airwaybill)
   * @param courier        - Kode kurir (jne, sicepat, dll) — wajib
   * @param lastPhone      - 5 digit terakhir nomor HP penerima — wajib untuk JNE
   */
  @Get('track/:awb')
  async trackShipment(
    @Param('awb') awb: string,
    @Query('courier') courier: string,
    @Query('last_phone') lastPhone?: string,
  ) {
    return this.logisticsService.trackShipment(awb, courier, lastPhone);
  }
}