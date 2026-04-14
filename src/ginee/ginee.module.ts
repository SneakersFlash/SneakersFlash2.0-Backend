import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from 'src/prisma/prisma.module';

import { GineeController } from './ginee.controller';
import { GineeClientService } from './services/ginee-client.service';
import { GineeProductService } from './services/ginee-product.service';
import { GineeOrderService } from './services/ginee-order.service';
import { GineeProcessor } from './ginee.processor';
import { GineeSyncAllProcessor } from './ginee-sync-all.processor';
import { GineeLogService } from './services/ginee-log.service';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    NotificationsModule,
    BullModule.registerQueue({ name: 'ginee-queue' }),
    BullModule.registerQueue({ name: 'ginee-sync-all-queue' }),
  ],
  controllers: [GineeController],
  providers: [
    GineeClientService,
    GineeProductService,
    GineeOrderService,
    GineeProcessor,
    GineeSyncAllProcessor,
    GineeLogService,
  ],
  exports: [GineeProductService, GineeOrderService],
})
export class GineeModule {}
