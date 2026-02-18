import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class RegisterDto {
    @IsString()
    @IsNotEmpty()
    name!: string;

    @IsEmail()
    @IsNotEmpty()
    email!: string;

    @IsString()
    @MinLength(6, { message: 'Password minimal 6 karakter' })
    password!: string;

    @IsString()
    @IsNotEmpty()
    phone!: string;
}