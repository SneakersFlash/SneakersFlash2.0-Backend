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

        // 👇 PERBAIKAN: Hubungkan ke Campaign
        campaign: {
          connect: { id: BigInt(dto.campaignId) }
        }
      }
    });
  }

  // 2. Find All
  async findAll() {
    return await this.prisma.voucher.findMany({
      // 👇 PERBAIKAN: Ganti 'createdAt' (tidak ada) menjadi 'id' atau 'startAt'
      orderBy: { id: 'desc' }
    });
  }

  // 3. Get One Voucher
  async findOne(id: number) {
    const voucher = await this.prisma.voucher.findUnique({
      where: { id: BigInt(id) }
    });
    if (!voucher) throw new NotFoundException('Voucher not found');

    // Serialisasi BigInt
    return {
      ...voucher,
      id: voucher.id.toString(),
      campaignId: voucher.campaignId.toString(), // Convert campaignId juga
      discountValue: Number(voucher.discountValue),
      minPurchaseAmount: Number(voucher.minPurchaseAmount),
      maxDiscountAmount: voucher.maxDiscountAmount ? Number(voucher.maxDiscountAmount) : null,
    };
  }

  // ... (Method update, remove, dan checkVoucherValidity biarkan sama seperti sebelumnya) ...
  // Pastikan Anda copy-paste sisa methodnya dari jawaban sebelumnya.

  // 4. Update Voucher
  async update(id: number, dto: UpdateVoucherDto) {
    await this.findOne(id);

    return await this.prisma.voucher.update({
      where: { id: BigInt(id) },
      data: {
        ...dto,
        startAt: dto.startAt ? new Date(dto.startAt) : undefined,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        // Jika mau update campaign juga:
        // campaign: dto.campaignId ? { connect: { id: BigInt(dto.campaignId) } } : undefined
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
    // A. Validasi Campaign
    const campaignExists = await this.prisma.campaign.findUnique({
      where: { id: BigInt(dto.campaignId) }
    });
    if (!campaignExists) {
      throw new BadRequestException(`Campaign ID ${dto.campaignId} tidak ditemukan.`);
    }

    // B. Siapkan Array Data
    const vouchersData: any = [];
    const generatedCodes = new Set(); // Untuk mencegah duplikat di batch yang sama

    for (let i = 0; i < dto.quantity; i++) {
      let uniqueCode = '';
      let isUnique = false;

      // Retry logic sederhana jika random string kebetulan sama (jarang terjadi)
      while (!isUnique) {
        const randomString = crypto.randomBytes(Math.ceil(dto.codeLength / 2))
          .toString('hex') // Convert ke Hex
          .slice(0, dto.codeLength)
          .toUpperCase();

        uniqueCode = `${dto.prefix}${randomString}`;

        if (!generatedCodes.has(uniqueCode)) {
          generatedCodes.add(uniqueCode);
          isUnique = true;
        }
      }

      vouchersData.push({
        campaignId: BigInt(dto.campaignId), // Mapping manual karena createMany tidak support 'connect'
        code: uniqueCode,
        name: `${dto.name} #${i + 1}`, // Nama dibedakan dikit biar enak trackingnya
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

    // C. Eksekusi Insert ke Database (createMany)
    // createMany lebih performant daripada loop create satu-satu
    try {
      const result = await this.prisma.voucher.createMany({
        data: vouchersData,
        skipDuplicates: true, // Jika kebetulan ada kode sama di DB, skip saja (opsional)
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
}