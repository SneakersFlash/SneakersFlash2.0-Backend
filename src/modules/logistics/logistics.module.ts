import { Module } from '@nestjs/common';
import { LogisticsService } from './logistics.service';
import { LogisticsController } from './logistics.controller';

@Module({
  controllers: [LogisticsController],
  providers: [LogisticsService],
  exports: [LogisticsService]
})
export class LogisticsModule { }
