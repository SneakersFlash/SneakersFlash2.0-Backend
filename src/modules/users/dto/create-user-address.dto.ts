import { IsString, IsOptional, IsBoolean, IsInt, IsNotEmpty } from 'class-validator';

export class CreateUserAddressDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsNotEmpty()
  @IsString()
  recipientName: string;

  @IsNotEmpty()
  @IsString()
  phone: string;

  @IsNotEmpty()
  @IsString()
  addressLine: string;

  @IsNotEmpty()
  @IsInt()
  provinceId: number;

  @IsNotEmpty()
  @IsInt()
  cityId: number;

  @IsNotEmpty()
  @IsInt()
  districtId: number;

  @IsOptional()
  @IsInt()
  subdistrictId?: number;

  @IsNotEmpty()
  @IsString()
  postalCode: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsInt()
  latitude?: number;

  @IsOptional()
  @IsInt()
  longtitude?: number;
}
