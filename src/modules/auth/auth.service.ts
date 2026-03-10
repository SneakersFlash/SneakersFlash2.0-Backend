import { BadRequestException, Injectable, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service'; // Pastikan path import benar
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library'; // <-- 1. Tambahkan Import

@Injectable()
export class AuthService {
  private googleClient: OAuth2Client;

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {
    // <-- 2. Inisialisasi Google Client
    // Pastikan Anda menaruh GOOGLE_CLIENT_ID di file .env backend Anda
    this.googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  }

  // --- HELPER FUNCTION UNTUK GENERATE TOKEN ---
  // Agar tidak mengulang kode di login() dan loginWithGoogle()
  private async generateTokenResponse(user: any) {
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
  // REGISTER LOKAL
  // ==========================================
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

    const { password, ...result } = user; // eslint-disable-line @typescript-eslint/no-unused-vars
    
    return {
      ...result,
      id: result.id.toString()
    };
  }

  // ==========================================
  // LOGIN LOKAL
  // ==========================================
  async login(loginDto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
    });

    // Validasi user ada dan memiliki password (bukan akun yang hanya login via Google)
    if (!user || !user.password) {
      throw new UnauthorizedException('Email atau Password salah');
    }

    const isMatch = await bcrypt.compare(loginDto.password, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Email atau Password salah');
    }

    // Gunakan helper
    return this.generateTokenResponse(user);
  }

  // ==========================================
  // LOGIN GOOGLE (BARU)
  // ==========================================
  async loginWithGoogle(token: string) {
    try {
      // Karena frontend mengirimkan Access Token, kita gunakan fetch
      // untuk mengambil profil user dari API Google
      const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Token Google tidak valid atau sudah kadaluarsa');
      }

      // Payload akan berisi data user dari Google: { email, name, picture, dll }
      const payload = await response.json();
      console.log('Google Payload:', payload); // Cek log di terminal backend
      
      if (!payload || !payload.email) {
        throw new UnauthorizedException('Tidak bisa mendapatkan email dari akun Google');
      }

      const { email, name } = payload;

      // 2. Cek apakah user sudah ada di database kita
      let user = await this.prisma.user.findUnique({
        where: { email },
      });

      // 3. Jika belum ada, otomatis buatkan akun (Auto-Register)
      if (!user) {
        user = await this.prisma.user.create({
          data: {
            email: email,
            name: name || 'Google User',
            role: 'customer',
            password: '', // Berikan string kosong jika schema Prisma wajib string
          },
        });
      }

      // 4. Kembalikan token internal aplikasi kita
      return this.generateTokenResponse(user);
      
    } catch (error: any) {
      // SANGAT PENTING: Tampilkan error asli di terminal agar mudah di-debug
      console.error('GOOGLE LOGIN ERROR:', error.message || error);
      
      throw new UnauthorizedException('Gagal memverifikasi akun Google');
    }
  }

  // ==========================================
  // GET PROFILE (ME)
  // ==========================================
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(userId) },
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

    return {
      ...user,
      id: user.id.toString(),
    };
  }
}