import { BadRequestException, Injectable, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service'; // Pastikan path import benar
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  // REGISTER
  async register(registerDto: RegisterDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: registerDto.email },
    });

    if (existingUser) {
      throw new BadRequestException('Email sudah terdaftar!');
    }

    const hashedPassword = await bcrypt.hash(registerDto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        name: registerDto.name,
        email: registerDto.email,
        password: hashedPassword,
        phone: registerDto.phone,
        role: 'customer', // Default role
      },
    });

    // Buang password dari response agar aman
    const { password, ...result } = user; // eslint-disable-line @typescript-eslint/no-unused-vars
    
    // Jangan lupa ubah id BigInt ke string jika dikembalikan ke frontend
    return {
      ...result,
      id: result.id.toString()
    };
  }

  // LOGIN
  async login(loginDto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Email atau Password salah');
    }

    const isMatch = await bcrypt.compare(loginDto.password, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Email atau Password salah');
    }

    // Buat Payload Token
    const payload = { 
      sub: user.id.toString(), // Convert BigInt ke String
      email: user.email, 
      role: user.role 
    };

    return {
      user: {
        id: user.id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
      },
      access_token: await this.jwtService.signAsync(payload),
    };
  }

  // ==========================================
  // GET PROFILE (ME)
  // ==========================================
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(userId) },
      // Select data yang mau dikembalikan (KECUALI password)
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
      }
    });

    if (!user) {
      throw new NotFoundException('User tidak ditemukan');
    }

    // Convert id BigInt ke string sebelum di-return
    return {
      ...user,
      id: user.id.toString(),
    };
  }
}