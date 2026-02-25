import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';
import { BannerPosition } from '@prisma/client'; // Import Enum dari Prisma

export class CreateBannerDto {
    @IsString()
    @IsNotEmpty()
    title: string;

    @IsString()
    @IsNotEmpty()
    imageDesktopUrl: string;

    @IsString()
    @IsOptional()
    imageMobileUrl?: string; // Opsional, kalau null nanti frontend pakai desktop url

    @IsString()
    @IsOptional()
    targetUrl?: string; // Link kalau banner diklik (misal ke /promo/lebaran)

    @IsEnum(BannerPosition)
    @IsNotEmpty()
    position: BannerPosition; // 'home_top', 'home_middle', 'category_page'

    @IsInt()
    @IsOptional()
    sortOrder?: number; // Urutan tampil (1, 2, 3)

    @IsBoolean()
    @IsOptional()
    isActive?: boolean;
}