import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { GineeController } from './ginee.controller';
import { GineeClientService } from './services/ginee-client.service';
import { GineeProductService } from './services/ginee-product.service';

@Module({
    imports: [PrismaModule],
    controllers: [GineeController],
    providers: [GineeClientService, GineeProductService],
    exports: [GineeProductService], // Export jika module lain (e.g. OrderModule) butuh
})
export class GineeModule {}