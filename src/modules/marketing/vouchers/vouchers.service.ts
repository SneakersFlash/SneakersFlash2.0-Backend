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

    if (activeOnly) {
      whereClause.isActive = true;
      whereClause.startAt = { lte: now };
      whereClause.expiresAt = { gte: now };
    }

    let vouchers = await this.prisma.voucher.findMany({
      where: whereClause,
      orderBy: { id: 'desc' },
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
        if (v.usageLimitTotal && v._count?.usages >= v.usageLimitTotal) {
          return false;
        }
        if (userId && v.usages && v.usages.length >= v.usageLimitPerUser) {
          return false;
        }
        return true;
      });
    }

    return vouchers.map((v: any) => {
      // ✅ Fix: "voucherUsage" → "usages"
      const { usages, _count, ...rest } = v;

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

  async findClaimable(userId: number) {
    const now = new Date();

    let vouchers = await this.prisma.voucher.findMany({
      where: {
        isActive: true,
        startAt: { lte: now },
        expiresAt: { gte: now },
        userId: null,
        // ✅ Fix: hapus "none" filter agar voucher yang sudah diklaim tetap muncul
      },
      orderBy: { id: 'desc' },
      include: {
        _count: {
          select: { usages: true }
        },
        usages: {
          where: { userId: BigInt(userId) }
        },
        // ✅ Fix: include claimedVouchers untuk cek status klaim, bukan untuk filter
        claimedVouchers: {
          where: { userId: BigInt(userId) }
        }
      }
    });

    // Filter kuota saja, voucher sudah diklaim tetap lolos
    vouchers = vouchers.filter((v: any) => {
      if (v.usageLimitTotal && v._count?.usages >= v.usageLimitTotal) {
        return false;
      }
      if (v.usages && v.usages.length >= v.usageLimitPerUser) {
        return false;
      }
      return true;
    });

    return vouchers.map((v: any) => {
      const { usages, _count, claimedVouchers, ...rest } = v;

      return {
        ...rest,
        id: v.id.toString(),
        campaignId: v.campaignId.toString(),
        discountValue: Number(v.discountValue),
        minPurchaseAmount: Number(v.minPurchaseAmount),
        maxDiscountAmount: v.maxDiscountAmount ? Number(v.maxDiscountAmount) : null,
        // ✅ Fix: kirim flag isClaimed ke frontend
        isClaimed: claimedVouchers.length > 0,
      };
    });
  }

  async findMyWallet(userId: number) {
    const now = new Date();
    
    const claimed = await this.prisma.userClaimedVoucher.findMany({
      where: { 
        userId: BigInt(userId),
        isUsed: false
      },
      include: {
        voucher: true
      },
      orderBy: { createdAt: 'desc' }
    });

    const validVouchers = claimed.filter(c => now <= c.voucher.expiresAt);

    return validVouchers.map((c: any) => ({
      ...c.voucher,
      id: c.voucher.id.toString(),
      campaignId: c.voucher.campaignId.toString(),
      discountValue: Number(c.voucher.discountValue),
      minPurchaseAmount: Number(c.voucher.minPurchaseAmount),
      maxDiscountAmount: c.voucher.maxDiscountAmount ? Number(c.voucher.maxDiscountAmount) : null,
      claimedAt: c.createdAt
    }));
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
      name: voucher.name,
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
    const voucher = await this.prisma.voucher.findUnique({
      where: { id: BigInt(voucherId) }
    });

    if (!voucher) throw new NotFoundException('Voucher tidak ditemukan');
    if (!voucher.isActive) throw new BadRequestException('Voucher sudah tidak aktif');

    const now = new Date();
    if (now < voucher.startAt) throw new BadRequestException('Voucher belum bisa diklaim');
    if (now > voucher.expiresAt) throw new BadRequestException('Voucher sudah kedaluwarsa');

    if (voucher.userId !== null && voucher.userId !== BigInt(userId)) {
      throw new BadRequestException('Voucher ini eksklusif untuk pengguna lain');
    }

    if (voucher.usageLimitTotal !== null) {
      const totalUsed = await this.prisma.voucherUsage.count({ where: { voucherId: voucher.id } });
      if (totalUsed >= voucher.usageLimitTotal) {
        throw new BadRequestException('Kuota voucher ini sudah habis');
      }
    }

    try {
      await this.prisma.userClaimedVoucher.create({
        data: {
          userId: BigInt(userId),
          voucherId: voucher.id
        }
      });
    } catch (error: any) {
      // Prisma error P2002 berarti data duplikat (Composite ID sudah ada)
      if (error.code === 'P2002') {
        throw new BadRequestException('Anda sudah mengklaim voucher ini sebelumnya.');
      }
      throw new InternalServerErrorException('Gagal mengklaim voucher');
    }

    return {
      success: true,
      message: 'Voucher berhasil Di Klaim!',
    };
  }
}