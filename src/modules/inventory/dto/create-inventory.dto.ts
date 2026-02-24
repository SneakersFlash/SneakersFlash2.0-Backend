import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { InventoryLogType } from '@prisma/client';

export class CreateInventoryDto {
    @IsInt()
    @IsNotEmpty()
    productVariantId!: number; // ID Varian Sepatu (misal: ID 5 untuk Size 40)

    @IsInt()
    @IsNotEmpty()
    quantityChange!: number; // Bisa Positif (+10 Restock) atau Negatif (-2 Rusak)

    @IsEnum(InventoryLogType)
    @IsNotEmpty()
    type!: InventoryLogType; // restock, damage, adjustment, dll.

    @IsString()
    @IsOptional()
    note?: string; // Catatan: "Barang datang dari Gudang A"

    @IsString()
    @IsOptional()
    referenceId?: string; // Nomor PO atau Resi (Opsional)
}