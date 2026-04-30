import { IsNotEmpty, IsOptional, IsString, MaxLength, Matches } from 'class-validator';

export class SyncEventSheetDto {
  @IsString()
  @IsNotEmpty({ message: 'sheetUrl wajib diisi.' })
  sheetUrl: string;

  @IsString()
  @IsNotEmpty({ message: 'sheetName wajib diisi.' })
  sheetName: string;

  @IsOptional()
  @IsString()
  @MaxLength(10, { message: 'skuPrefix maksimal 10 karakter.' })
  @Matches(/^[A-Z0-9]+$/i, { message: 'skuPrefix hanya boleh berisi huruf dan angka.' })
  skuPrefix?: string; // default 'EVT' di service jika tidak diisi
}