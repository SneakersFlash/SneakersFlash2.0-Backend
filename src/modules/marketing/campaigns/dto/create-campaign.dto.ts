// src/modules/marketing/campaigns/dto/create-campaign.dto.ts
import { IsString, IsOptional, IsDateString, IsNumber, IsBoolean, Min } from 'class-validator';

export class CreateCampaignDto {
    @IsString()
    name: string;

    @IsOptional()
    @IsString()
    description?: string;

    @IsDateString()
    startAt: string;

    @IsDateString()
    endAt: string;

    @IsOptional()
    @IsNumber()
    @Min(0)
    totalBudgetLimit?: number;

    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}