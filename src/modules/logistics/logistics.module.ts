import { Module } from '@nestjs/common';
import { LogisticsService } from './logistics.service';
import { LogisticsController } from './logistics.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [LogisticsController],
  providers: [LogisticsService],
  exports: [LogisticsService]
})
export class LogisticsModule { }
