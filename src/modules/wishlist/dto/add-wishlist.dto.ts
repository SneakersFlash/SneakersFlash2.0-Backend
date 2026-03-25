import { IsNotEmpty, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class AddWishlistDto {
  @IsNotEmpty()
  @IsNumber()
  @Type(() => Number)
  productId: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  productVariantId?: number;
}
