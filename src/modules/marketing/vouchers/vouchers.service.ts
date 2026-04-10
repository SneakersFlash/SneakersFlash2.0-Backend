import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { CreateBulkVoucherDto } from './dto/create-bulk-voucher.dto';
import * as crypto from 'crypto';

@Injectable()
export class VouchersService {
  private readonly logger = new Logger(VouchersService.name);

  constructor(private prisma: PrismaService) { }

  // 1. Create Voucher (Admin)
  async create(dto: CreateVoucherDto) {
    // Cek duplikat kode
    const existing = await this.prisma.voucher.findUnique({
      where: { code: dto.code }
    });

    if (existing) {
      throw new BadRequestException(`Voucher code '${dto.code}' already exists!`);
    }

    const campaignExists = await this.prisma.campaign.findUnique({
      where: { id: BigInt(dto.campaignId) }
    });

    if (!campaignExists) {
      throw new BadRequestException(`Campaign dengan ID ${dto.campaignId} tidak ditemukan.`);
    }

    return await this.prisma.voucher.create({
      data: {
        code: dto.code,
        name: dto.name,
        description: dto.description,
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        maxDiscountAmount: dto.maxDiscountAmount,
        minPurchaseAmount: dto.minPurchaseAmount,
        usageLimitTotal: dto.usageLimitTotal,
        usageLimitPerUser: dto.usageLimitPerUser || 1,
        startAt: new Date(dto.startAt),
        expiresAt: new Date(dto.expiresAt),
        isActive: dto.isActive ?? true,
        campaign: {
          connect: { id: BigInt(dto.campaignId) }
        }
      }
    });
  }

  async findAll(activeOnly?: boolean, userId?: number) {
    const now = new Date();
    const whereClause: any = {};

    // Filter berdasarkan status & waktu event
    if (activeOnly) {
      whereClause.isActive = true;
      whereClause.startAt = { lte: now };
      whereClause.expiresAt = { gte: now };
    }

    let vouchers = await this.prisma.voucher.findMany({
      where: whereClause,
      orderBy: { id: 'desc' },
      // Tarik juga data total pemakaian global dan pemakaian oleh user ini
      include: {
        _count: {
          select: { usages: true } 
        },
        ...(userId ? {
          usages: {
            where: { userId: BigInt(userId) }
          }
        } : {})
      }
    });

    if (activeOnly) {
      vouchers = vouchers.filter((v: any) => {
        // 1. Cek Kuota Global
        if (v.usageLimitTotal && v._count?.voucherUsage >= v.usageLimitTotal) {
          return false;
        }
        // 2. Cek Limit Per User
        if (userId && v.voucherUsage && v.voucherUsage.length >= v.usageLimitPerUser) {
          return false;
        }
        return true;
      });
    }

    // Return & Serialisasi BigInt agar tidak error di JSON
    return vouchers.map((v: any) => {
      // Buang relasi yang tidak perlu dikirim ke frontend
      const { voucherUsage, _count, ...rest } = v; 
      
      return {
        ...rest,
        id: v.id.toString(),
        campaignId: v.campaignId.toString(),
        discountValue: Number(v.discountValue),
        minPurchaseAmount: Number(v.minPurchaseAmount),
        maxDiscountAmount: v.maxDiscountAmount ? Number(v.maxDiscountAmount) : null,
      };
    });
  }

  // 3. Get One Voucher
  async findOne(id: number) {
    const voucher = await this.prisma.voucher.findUnique({
      where: { id: BigInt(id) }
    });
    if (!voucher) throw new NotFoundException('Voucher not found');

    return {
      ...voucher,
      id: voucher.id.toString(),
      campaignId: voucher.campaignId.toString(),
      discountValue: Number(voucher.discountValue),
      minPurchaseAmount: Number(voucher.minPurchaseAmount),
      maxDiscountAmount: voucher.maxDiscountAmount ? Number(voucher.maxDiscountAmount) : null,
    };
  }

  // 4. Update Voucher
  async update(id: number, dto: UpdateVoucherDto) {
    await this.findOne(id);

    return await this.prisma.voucher.update({
      where: { id: BigInt(id) },
      data: {
        ...dto,
        startAt: dto.startAt ? new Date(dto.startAt) : undefined,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      }
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return await this.prisma.voucher.delete({
      where: { id: BigInt(id) }
    });
  }

  async checkVoucherValidity(code: string, userId: number, purchaseAmount: number) {
    const voucher = await this.prisma.voucher.findUnique({
      where: { code: code, isActive: true }
    });

    if (!voucher) throw new BadRequestException('Kode voucher tidak ditemukan/tidak aktif.');

    const now = new Date();
    if (now < voucher.startAt || now > voucher.expiresAt) {
      throw new BadRequestException('Voucher belum mulai atau sudah kedaluwarsa.');
    }

    if (purchaseAmount < Number(voucher.minPurchaseAmount)) {
      throw new BadRequestException(`Belanja kurang. Min: ${Number(voucher.minPurchaseAmount)}`);
    }

    if (voucher.usageLimitTotal) {
      const globalUsage = await this.prisma.voucherUsage.count({ where: { voucherId: voucher.id } });
      if (globalUsage >= voucher.usageLimitTotal) throw new BadRequestException('Kuota voucher habis.');
    }

    const userUsage = await this.prisma.voucherUsage.count({
      where: { voucherId: voucher.id, userId: BigInt(userId) }
    });
    if (userUsage >= voucher.usageLimitPerUser) throw new BadRequestException('Anda sudah pakai voucher ini.');

    let discount = 0;
    if (voucher.discountType === 'fixed_amount') {
      discount = Number(voucher.discountValue);
    } else if (voucher.discountType === 'percentage') {
      discount = (purchaseAmount * Number(voucher.discountValue)) / 100;
      if (voucher.maxDiscountAmount) {
        discount = Math.min(discount, Number(voucher.maxDiscountAmount));
      }
    }

    return {
      valid: true,
      code: voucher.code,
      discountAmount: discount,
      message: 'Voucher valid!'
    };
  }

  async createBulk(dto: CreateBulkVoucherDto) {
    const campaignExists = await this.prisma.campaign.findUnique({
      where: { id: BigInt(dto.campaignId) }
    });
    if (!campaignExists) {
      throw new BadRequestException(`Campaign ID ${dto.campaignId} tidak ditemukan.`);
    }

    const vouchersData: any = [];
    const generatedCodes = new Set();

    for (let i = 0; i < dto.quantity; i++) {
      let uniqueCode = '';
      let isUnique = false;

      while (!isUnique) {
        const randomString = crypto.randomBytes(Math.ceil(dto.codeLength / 2))
          .toString('hex')
          .slice(0, dto.codeLength)
          .toUpperCase();

        uniqueCode = `${dto.prefix}${randomString}`;

        if (!generatedCodes.has(uniqueCode)) {
          generatedCodes.add(uniqueCode);
          isUnique = true;
        }
      }

      vouchersData.push({
        campaignId: BigInt(dto.campaignId), 
        code: uniqueCode,
        name: `${dto.name} #${i + 1}`,
        description: dto.description,
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        maxDiscountAmount: dto.maxDiscountAmount,
        minPurchaseAmount: dto.minPurchaseAmount,
        usageLimitTotal: dto.usageLimitTotal,
        usageLimitPerUser: dto.usageLimitPerUser || 1,
        startAt: new Date(dto.startAt),
        expiresAt: new Date(dto.expiresAt),
        isActive: dto.isActive ?? true,
      });
    }

    try {
      const result = await this.prisma.voucher.createMany({
        data: vouchersData,
        skipDuplicates: true, 
      });

      return {
        message: 'Bulk create success',
        count: result.count,
        prefix: dto.prefix,
        campaignId: dto.campaignId
      };
    } catch (error) {
      this.logger.error('Bulk Create Error', error);
      throw new InternalServerErrorException('Gagal membuat bulk voucher');
    }
  }

  // ========================================================
  // Klaim Voucher (User)
  // ========================================================
  async claimVoucher(userId: number, voucherId: string) {
    // 1. Cari voucher berdasarkan ID
    const voucher = await this.prisma.voucher.findUnique({
      where: { id: BigInt(voucherId) }
    });

    if (!voucher) {
      throw new NotFoundException('Voucher tidak ditemukan');
    }

    // 2. Validasi Status & Waktu Aktif
    if (!voucher.isActive) {
      throw new BadRequestException('Voucher sudah tidak aktif');
    }

    const now = new Date();
    if (now < voucher.startAt) {
      throw new BadRequestException('Voucher belum bisa diklaim/digunakan');
    }
    if (now > voucher.expiresAt) {
      throw new BadRequestException('Voucher sudah kedaluwarsa');
    }

    // 3. Validasi Kepemilikan (Private Voucher Logic)
    if (voucher.userId !== null) {
      if (voucher.userId === BigInt(userId)) {
        throw new BadRequestException('Voucher ini sudah Anda klaim sebelumnya');
      } else {
        throw new BadRequestException('Voucher ini tidak valid atau milik pengguna lain');
      }
    }

    // 4. Validasi Limit Kuota Global (Jika Ada)
    if (voucher.usageLimitTotal !== null) {
      const totalUsed = await this.prisma.voucherUsage.count({
        where: { voucherId: voucher.id }
      });
      if (totalUsed >= voucher.usageLimitTotal) {
        throw new BadRequestException('Kuota voucher ini sudah habis diklaim orang lain');
      }
    }

    // 5. Validasi Limit Per User
    const userUsed = await this.prisma.voucherUsage.count({
      where: { 
        voucherId: voucher.id,
        userId: BigInt(userId) 
      }
    });

    if (userUsed >= voucher.usageLimitPerUser) {
      throw new BadRequestException('Anda sudah mencapai batas maksimal penggunaan voucher ini');
    }

    // 6. Logic "Claim" & Kunci Voucher
    let updatedVoucher = voucher;

    // Jika voucher ini hanya bisa dipakai 1x total (Voucher unik/eksklusif),
    // kita "kunci" voucher ini untuk user yang mengklaim dengan mengisi field `userId`.
    if (voucher.usageLimitTotal === 1 && voucher.userId === null) {
      updatedVoucher = await this.prisma.voucher.update({
        where: { id: voucher.id },
        data: { userId: BigInt(userId) }
      });
    }

    // Serialize BigInt & Decimal agar aman saat di-return sebagai JSON
    return {
      success: true,
      message: 'Voucher berhasil diklaim!',
      voucher: {
        ...updatedVoucher,
        id: updatedVoucher.id.toString(),
        campaignId: updatedVoucher.campaignId.toString(),
        userId: updatedVoucher.userId?.toString() || null,
        discountValue: Number(updatedVoucher.discountValue),
        maxDiscountAmount: updatedVoucher.maxDiscountAmount ? Number(updatedVoucher.maxDiscountAmount) : null,
        minPurchaseAmount: Number(updatedVoucher.minPurchaseAmount),
      }
    };
  }
}