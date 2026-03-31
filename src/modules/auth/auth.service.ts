import { BadRequestException, Injectable, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service'; // Pastikan path import benar
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';
import appleSignin from 'apple-signin-auth'; 

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
      const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Token Google tidak valid atau sudah kadaluarsa');
      }

      const payload = await response.json();
      console.log('Google Payload:', payload); 
      if (!payload || !payload.email) {
        throw new UnauthorizedException('Tidak bisa mendapatkan email dari akun Google');
      }

      const { email, name } = payload;
      
      let user = await this.prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        user = await this.prisma.user.create({
          data: {
            email: email,
            name: name || 'Google User',
            role: 'customer',
            password: '',
          },
        });
      }

      return this.generateTokenResponse(user);
      
    } catch (error: any) {
      console.error('GOOGLE LOGIN ERROR:', error.message || error);
      
      throw new UnauthorizedException('Gagal memverifikasi akun Google');
    }
  }

  // BUTUH CLIENT ID DARI APPLE DEVELOPER
  // async loginWithApple(idToken: string, providedName?: string) {
  //   try {
  //     // 1. Verifikasi token ke server Apple
  //     const payload = await appleSignin.verifyIdToken(idToken, {
  //       // Audience biasanya adalah Bundle ID aplikasi iOS Anda (misal: com.sneakersflash.app)
  //       // atau Client ID dari Service ID web Anda.
  //       audience: process.env.APPLE_CLIENT_ID, 
  //       ignoreExpiration: true, // Sesuai kebutuhan, bisa di set false
  //     });

  //     const appleId = payload.sub; // ID unik user dari Apple
  //     const email = payload.email;

  //     // 2. Cek apakah user sudah ada berdasarkan appleId atau email
  //     let user = await this.prisma.user.findFirst({
  //       where: {
  //         OR: [
  //           { appleId: appleId },
  //           { email: email }
  //         ]
  //       },
  //     });

  //     // 3. Jika belum ada, otomatis buatkan akun
  //     if (!user) {
  //       user = await this.prisma.user.create({
  //         data: {
  //           // Jika user pakai "Hide My Email", kita simpan email dummy dari Apple
  //           email: email || `${appleId}@privaterelay.appleid.com`, 
  //           name: providedName || 'Apple User',
  //           role: 'customer',
  //           appleId: appleId,
  //           password: '', // string kosong karena schema wajib string
  //         },
  //       });
  //     } else if (!user.appleId) {
  //       user = await this.prisma.user.update({
  //         where: { id: user.id },
  //         data: { appleId: appleId },
  //       });
  //     }


  //     return this.generateTokenResponse(user);
  //   } catch (error: any) {
  //     console.error('APPLE LOGIN ERROR:', error.message || error);
  //     throw new UnauthorizedException('Gagal memverifikasi akun Apple');
  //   }
  // }

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