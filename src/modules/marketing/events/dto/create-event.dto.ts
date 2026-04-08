import { IsBoolean, IsDateString, IsJSON, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateEventDto {
    @IsString()
    @IsNotEmpty()
    title: string;

    @IsString()
    @IsNotEmpty()
    slug: string;

    @IsString()
    @IsOptional()
    bannerDesktopUrl?: string;

    @IsString()
    @IsOptional()
    bannerMobileUrl?: string;

    @IsString()
    @IsOptional()
    contentHtml?: string;

    @IsOptional()
    styleConfig?: Record<string, any>;; // Bisa diperjelas strukturnya nanti

    @IsDateString()
    startAt: string;

    @IsDateString()
    endAt: string;

    @IsBoolean()
    @IsOptional()
    isActive?: boolean;

    @IsBoolean()
    @IsOptional()
    isTimer?: boolean;

    @IsNumber()
    @IsOptional()
    sort?: number;
}