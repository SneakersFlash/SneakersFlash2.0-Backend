import { IsBoolean, IsDateString, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { DiscountType } from '@prisma/client'; // Import Enum dari Prisma

export class CreateVoucherDto {
    @IsString()
    @IsNotEmpty()
    code: string;

    @IsString()
    @IsNotEmpty()
    name: string;

    @IsOptional()
    @IsString()
    description?: string;

    @IsEnum(DiscountType)
    @IsNotEmpty()
    discountType: DiscountType; // 'percentage' | 'fixed_amount' | 'free_shipping'

    @IsNumber()
    @Min(0)
    discountValue: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    maxDiscountAmount?: number; // Maksimal potongan (untuk persentase)

    @IsNumber()
    @Min(0)
    minPurchaseAmount: number;

    @IsOptional()
    @IsNumber()
    @Min(1)
    usageLimitTotal?: number; // Kuota Global

    @IsNumber()
    @Min(1)
    usageLimitPerUser: number; // Kuota per User (Default 1)

    @IsDateString()
    @IsNotEmpty()
    startAt: string; // Format ISO: "2026-03-01T00:00:00Z"

    @IsDateString()
    @IsNotEmpty()
    expiresAt: string;

    @IsOptional()
    @IsBoolean()
    isActive?: boolean;

    @IsNumber()
    @IsNotEmpty()
    campaignId: number;
}