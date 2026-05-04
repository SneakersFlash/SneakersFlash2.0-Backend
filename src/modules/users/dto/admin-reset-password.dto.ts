import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class AdminResetPasswordDto {
  @IsNotEmpty()
  @IsString()
  @MinLength(6, { message: 'Password minimal 6 karakter' })
  newPassword: string;
}
