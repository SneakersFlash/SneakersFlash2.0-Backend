import { IsBoolean, IsDateString, IsJSON, IsNotEmpty, IsOptional, IsString } from 'class-validator';

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
    styleConfig?: any; // Bisa diperjelas strukturnya nanti

    @IsDateString()
    startAt: string;

    @IsDateString()
    endAt: string;

    @IsBoolean()
    @IsOptional()
    isActive?: boolean;
}