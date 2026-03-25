import { IsOptional, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class WishlistQueryDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  limit?: number = 20;
}
