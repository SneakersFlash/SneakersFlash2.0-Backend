import { IsInt, IsNotEmpty, Min } from 'class-validator';

export class AddToCartDto {
    @IsInt()
    @IsNotEmpty()
    productVariantId!: number; // ID Varian (misal: Size 40)

    @IsInt()
    @Min(1)
    quantity!: number; // Jumlah beli (min 1)
}