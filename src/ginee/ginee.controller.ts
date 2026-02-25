import { Body, Controller, Post, Headers, UnauthorizedException } from '@nestjs/common';
import { GineeProductService } from './services/ginee-product.service';

@Controller('ginee')
export class GineeController {
    constructor(private readonly gineeProductService: GineeProductService) {}

    @Post('webhook/stock-update')
    async handleStockWebhook(@Body() payload: any, @Headers('X-Ginee-Signature') signature: string) {
        if (payload.sku && payload.stock !== undefined) {
            await this.gineeProductService.updateStockFromWebhook(payload.sku, payload.stock);
        }
        
        return { status: 'SUCCESS' };
    }

    @Post('sync/push-product')
    async manualPushProduct(@Body('productId') id: number) {
        return await this.gineeProductService.pushProductToGinee(id);
    }
}