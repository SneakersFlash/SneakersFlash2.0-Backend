import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

// Object untuk Alamat Pengiriman (Snapshot)
class ShippingAddressDto {
    @IsString()
    @IsNotEmpty()
    recipientName!: string;

    @IsString()
    @IsNotEmpty()
    phone: string;

    @IsString()
    @IsNotEmpty()
    addressLine!: string;

    @IsString()
    @IsNotEmpty()
    city!: string;

    @IsInt() // <--- TAMBAHAN BARU (ID Kecamatan Komerce)
    @IsNotEmpty()
    subdistrictId: number;

    @IsString()
    @IsNotEmpty()
    postalCode!: string;

    @IsOptional()
    @IsNumber()
    latitude: number;

    @IsOptional()
    @IsNumber()
    longitude: number
}

// Object untuk Ekspedisi (JNE/J&T)
class CourierDto {
    @IsString()
    @IsNotEmpty()
    name!: string; // JNE

    @IsString()
    @IsNotEmpty()
    service!: string; // REG

    @IsNumber()
    @Min(0)
    cost!: number; // Ongkir (misal: 15000)
}

export class CreateOrderDto {
    // Kita terima object Alamat & Kurir

    @IsOptional()
    @IsArray()
    cartItemIds?: string[] | number[];

    // === TAMBAHAN UNTUK FITUR BUY NOW ===
    @IsOptional()
    @IsNumber()
    buyNowVariantId?: string | number;

    @IsOptional()
    @IsNumber()
    buyNowQuantity?: number;

    @IsNotEmpty()
    @Type(() => ShippingAddressDto)
    address!: ShippingAddressDto;

    @IsNotEmpty()
    @Type(() => CourierDto)
    courier!: CourierDto;

    @IsString()
    @IsOptional()
    voucherCode?: string; // Nanti buat diskon

    @IsString()
    @IsOptional()
    paymentMethod?: string;

    @IsBoolean()
    @IsOptional()
    usePoints?: boolean;

    @IsNumber()
    @IsOptional()
    @Min(0)
    pointsToRedeem?: number;
}