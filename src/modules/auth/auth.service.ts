import { BadRequestException, Injectable, UnauthorizedException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';
import appleSignin from 'apple-signin-auth';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private googleClient: OAuth2Client;

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private notificationsService: NotificationsService
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
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // Expired 5 Menit

    await this.prisma.user.create({
      data: {
        name: registerDto.name,
        email: registerDto.email,
        password: hashedPassword,
        phone: registerDto.phone,
        role: 'customer',
        otpCode: otpCode,
        otpExpiresAt: otpExpiresAt, // Disimpan ke DB
        emailVerifiedAt: null,      // Dikosongkan karena belum verifikasi
      },
    });

    // Kirim email OTP
    this.notificationsService.sendOtpEmail(registerDto.email, otpCode)
      .catch(err => this.logger.error(`Gagal kirim OTP ke ${registerDto.email}`, err));

    return { 
      success: true, 
      message: 'Registrasi berhasil. Silakan cek email Anda untuk OTP verifikasi.' 
    };
  }

  // ==========================================
  // VERIFY OTP
  // ==========================================
  async verifyOtp(email: string, otp: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) throw new NotFoundException('User tidak ditemukan');
    
    // Cek pakai emailVerifiedAt
    if (user.emailVerifiedAt !== null) {
      throw new BadRequestException('Email sudah diverifikasi');
    }
    
    if (user.otpCode !== otp) throw new BadRequestException('Kode OTP salah');
    
    // Cek kadaluarsa
    if (!user.otpExpiresAt || new Date() > user.otpExpiresAt) {
      throw new BadRequestException('Kode OTP sudah kadaluarsa');
    }

    // Update user jadi terverifikasi & hapus OTP
    const updatedUser = await this.prisma.user.update({
      where: { email },
      data: {
        emailVerifiedAt: new Date(), // Isi dengan tanggal sekarang
        otpCode: null,
        otpExpiresAt: null,
      },
    });

    const welcomeVoucher = await this.giveWelcomeVoucher(updatedUser.id);
    const tokenResponse = await this.generateTokenResponse(updatedUser);

    return {
      ...tokenResponse,
      welcomeVoucher,
    }
  }

  async resendOtp(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) throw new NotFoundException('User tidak ditemukan');
    
    // PERBAIKAN DI SINI: Gunakan emailVerifiedAt, bukan isEmailVerified
    if (user.emailVerifiedAt !== null) {
        throw new BadRequestException('Email sudah diverifikasi');
    }

    // Generate OTP baru
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 Menit

    await this.prisma.user.update({
      where: { email },
      data: { otpCode, otpExpiresAt },
    });

    this.notificationsService.sendOtpEmail(user.email, otpCode)
      .catch(err => this.logger.error(`Gagal kirim ulang OTP ke ${email}`, err));

    return { success: true, message: 'OTP baru telah dikirim ke email Anda.' };
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
      this.logger.log(`Google userinfo diterima untuk email: ${payload?.email}`);
      if (!payload || !payload.email) {
        throw new UnauthorizedException('Tidak bisa mendapatkan email dari akun Google');
      }

      const { email, name } = payload;
      
      let user = await this.prisma.user.findUnique({
        where: { email },
      });

      let isNewUser = false;

      if (!user) {
        const randomPassword = await bcrypt.hash(crypto.randomUUID(), 10);
        user = await this.prisma.user.create({
          data: {
            email: email,
            name: name || 'Google User',
            role: 'customer',
            password: randomPassword,
          },
        });
        isNewUser = true;
      }

      let welcomeVoucher: any = null;
      if (isNewUser) {
        welcomeVoucher = await this.giveWelcomeVoucher(user.id);
      }
      const tokenResponse = await this.generateTokenResponse(user);

      return {
        ...tokenResponse,
        welcomeVoucher,
      };
    } catch (error: any) {
      this.logger.error(`GOOGLE LOGIN ERROR: ${error.message || error}`);
      
      throw new UnauthorizedException('Gagal memverifikasi akun Google');
    }
  }

  // BUTUH CLIENT ID DARI APPLE DEVELOPER
  async loginWithApple(idToken: string, providedName?: string) {
    try {
      // 1. Verifikasi token ke server Apple
      const payload = await appleSignin.verifyIdToken(idToken, {
        // Audience biasanya adalah Bundle ID aplikasi iOS Anda (misal: com.sneakersflash.app)
        // atau Client ID dari Service ID web Anda.
        audience: process.env.APPLE_CLIENT_ID, 
        ignoreExpiration: false, // Sesuai kebutuhan, bisa di set false
      });

      const appleId = payload.sub; // ID unik user dari Apple
      const email = payload.email;

      // 2. Cek apakah user sudah ada berdasarkan appleId atau email
      let user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { appleId: appleId },
            { email: email }
          ]
        },
      });

      // 3. Jika belum ada, otomatis buatkan akun
      if (!user) {
        user = await this.prisma.user.create({
          data: {
            // Jika user pakai "Hide My Email", kita simpan email dummy dari Apple
            email: email || `${appleId}@privaterelay.appleid.com`, 
            name: providedName || 'Apple User',
            role: 'customer',
            appleId: appleId,
            password: '', // string kosong karena schema wajib string
          },
        });
      } else if (!user.appleId) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { appleId: appleId },
        });
      }


      return this.generateTokenResponse(user);
    } catch (error: any) {
      this.logger.error(`APPLE LOGIN ERROR: ${error.message || error}`);
      throw new UnauthorizedException('Gagal memverifikasi akun Apple');
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

  private async giveWelcomeVoucher(userId: bigint): Promise<object | null> {
  try {
    const existing = await this.prisma.voucher.findFirst({
      where: { userId, campaignId: BigInt(1) }
    });
    if (existing) return null;

    const code = `FIRSTSTEP-${userId.toString()}`;

    const voucher = await this.prisma.voucher.create({
      data: {
        code,
        name: 'First Step - Welcome Bonus',
        description: 'Voucher selamat datang untuk member baru',
        discountType: 'fixed_amount',
        discountValue: 100000,
        minPurchaseAmount: 500000,
        maxDiscountAmount: null,
        usageLimitTotal: 1,
        usageLimitPerUser: 1,
        startAt: new Date(),
        expiresAt: new Date('2030-12-31T23:59:59.000Z'),
        isActive: true,
        userId,
        campaignId: BigInt(1),
      }
    });

    await this.prisma.userClaimedVoucher.create({
      data: { userId, voucherId: voucher.id }
    });

    this.logger.log(`Welcome voucher '${code}' dibuat & diklaim user ${userId}`);

    // Return data yang dibutuhkan frontend untuk popup
    return {
      code: voucher.code,
      name: voucher.name,
      description: voucher.description,
      discountType: voucher.discountType,
      discountValue: Number(voucher.discountValue),
      minPurchaseAmount: Number(voucher.minPurchaseAmount),
      expiresAt: voucher.expiresAt,
    };
  } catch (err: any) {
    this.logger.error(`Gagal memberi welcome voucher: ${err.message}`);
    return null;
  }
}
}