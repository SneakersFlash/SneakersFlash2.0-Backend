import { Type } from 'class-transformer';
import { 
    IsArray, 
    IsNotEmpty, 
    IsNumber, 
    IsOptional, 
    IsString, 
    Min, 
    ValidateNested 
} from 'class-validator';

// 1. DTO khusus untuk Varian (Child)
export class CreateProductVariantDto {
    @IsString()
    @IsNotEmpty()
    sku!: string;

    @IsNumber()
    @Min(0)
    price!: number;

    @IsNumber()
    @Min(0)
    stockQuantity!: number;

    @IsString()
    @IsOptional()
    imageUrl?: string;
}

// 2. DTO khusus untuk Produk Utama (Parent)
export class CreateProductDto {
    @IsNumber()
    @IsNotEmpty()
    categoryId!: number;

    @IsNumber()
    @IsOptional()
    brandId?: number;

    @IsString()
    @IsNotEmpty()
    name!: string;

    @IsString()
    @IsOptional()
    description?: string;

    @IsNumber()
    @Min(0)
    basePrice!: number;

    @IsNumber()
    @Min(1)
    weightGrams!: number;

    // Validasi Array of Object (Varian)
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CreateProductVariantDto)
    variants!: CreateProductVariantDto[];
}