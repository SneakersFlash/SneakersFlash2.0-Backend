import { PartialType } from '@nestjs/mapped-types';
import { CreateUserDto } from './create-user.dto';
import { OmitType } from '@nestjs/swagger'; // Opsional jika pakai swagger, jika tidak pakai OmitType dari @nestjs/mapped-types

export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['email', 'password'] as const)
) {}