import { IsNotEmpty, IsNumber, IsString, Min, IsOptional } from 'class-validator';
import { OmitType } from '@nestjs/mapped-types';
import { CreateVoucherDto } from './create-voucher.dto';

// Kita ambil semua field dari CreateVoucherDto KECUALI 'code'
export class CreateBulkVoucherDto extends OmitType(CreateVoucherDto, ['code'] as const) {

    @IsNumber()
    @Min(1)
    quantity: number;

    @IsString()
    @IsOptional()
    prefix: string = 'PROMO';

    @IsNumber()
    @IsOptional()
    codeLength: number = 8;
}