// src/products/dto/product-query.dto.ts
import { IsOptional, IsString, IsInt, Min, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export class ProductQueryDto {
    @IsOptional()
    @IsInt()
    @Type(() => Number)
    @Min(1)
    page?: number = 1;

    @IsOptional()
    @IsInt()
    @Type(() => Number)
    @Min(1)
    limit?: number = 10;

    @IsOptional()
    @IsString()
    search?: string;

    @IsOptional()
    @IsString()
    category?: string;

    @IsOptional()
    @IsString()
    brand?: string;

    @IsOptional()
    @IsInt()
    @Type(() => Number)
    categoryId?: number;

    @IsOptional()
    @IsInt()
    @Type(() => Number)
    brandId?: number;

    @IsOptional()
    @IsString()
    sortBy?: string = 'createdAt'; // Default sort

    @IsOptional()
    @IsEnum(SortOrder)
    sortOrder?: SortOrder = SortOrder.DESC;
}