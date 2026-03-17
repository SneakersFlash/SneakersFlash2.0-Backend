import { IsNotEmpty, IsNumber, IsOptional, IsString, IsBoolean } from 'class-validator';
export class CreateLogisticDto { }

export class CalculateShippingDto {
    @IsNotEmpty()
    @IsNumber()
    destinationSubdistrictId: number;

    @IsNotEmpty()
    @IsNumber()
    weightGrams: number;

    @IsOptional()
    @IsString()
    courier?: string;

    // FIELD BARU DARI INPUT USER
    @IsOptional()
    @IsNumber()
    itemValue?: number; // Total harga barang di keranjang

    @IsOptional()
    @IsBoolean()
    isCod?: boolean;
    
    @IsOptional()
    @IsString()
    originPinPoint?: 'string';    // Format: "lat,long" (contoh: "-7.455, 109.287")

    @IsOptional()
    @IsString()
    destinationPinPoint?: string;   // User centang "Bayar di Tempat" atau tidak
}