// src/modules/marketing/campaigns/campaigns.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service'; // Sesuaikan path jika berbeda
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';

@Injectable()
export class CampaignsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateCampaignDto) {
    // Generate slug sederhana dari nama campaign
    const slug = dto.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();

    return this.prisma.campaign.create({
      data: {
        name: dto.name,
        slug: slug,
        description: dto.description,
        startAt: new Date(dto.startAt),
        endAt: new Date(dto.endAt),
        totalBudgetLimit: dto.totalBudgetLimit,
        isActive: dto.isActive !== undefined ? dto.isActive : true,
      },
    });
  }

  async findAll() {
    const campaigns = await this.prisma.campaign.findMany({
      orderBy: { id: 'desc' },
    });

    return campaigns.map(campaign => this.serialize(campaign));
  }

  async findAllActive() {
    const campaigns = await this.prisma.campaign.findMany({
      where: {
        isActive: true,
        startAt: { lte: new Date() },
        endAt: { gte: new Date() },
      },
      include: {
        vouchers: true, 
      }
    });

    return campaigns.map(campaign => this.serialize(campaign));
  }

  async findOne(id: number) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: BigInt(id) },
      include: { vouchers: true }
    });

    if (!campaign) throw new NotFoundException('Campaign tidak ditemukan');
    return this.serialize(campaign);
  }

  async update(id: number, dto: UpdateCampaignDto) {
    await this.findOne(id); // Pastikan data ada sebelum di-update

    let slug;
    if (dto.name) {
      slug = dto.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
    }

    return this.prisma.campaign.update({
      where: { id: BigInt(id) },
      data: {
        ...dto,
        slug,
        startAt: dto.startAt ? new Date(dto.startAt) : undefined,
        endAt: dto.endAt ? new Date(dto.endAt) : undefined,
      },
    });
  }

async remove(id: number) {
    await this.findOne(id); 

    const relatedVouchersCount = await this.prisma.voucher.count({
      where: { campaignId: BigInt(id) }
    });

    if (relatedVouchersCount > 0) {
      throw new BadRequestException(
        'Kampanye tidak dapat dihapus karena masih memiliki voucher yang terhubung. Silakan ubah status kampanye menjadi Tidak Aktif (Inactive).'
      );
    }

    await this.prisma.campaign.delete({
      where: { id: BigInt(id) }
    });

    return { message: 'Kampanye berhasil dihapus' };
  }
  
  async checkBudgetAvailability(campaignId: number, discountAmount: number) {
    const campaign = await this.findOne(campaignId);

    // Konversi Decimal Prisma ke Number untuk kalkulasi
    const limit = Number(campaign.totalBudgetLimit) || 0;
    const used = Number(campaign.totalUsedBudget) || 0;

    if (limit === 0) return true; // Jika null atau 0, asumsikan budget unlimited

    const remainingBudget = limit - used;
    return remainingBudget >= discountAmount;
  }

  private serialize(campaign: any) {
    if (!campaign) return null;
    
    return {
      ...campaign,
      id: campaign.id.toString(), 
      totalBudgetLimit: campaign.totalBudgetLimit ? Number(campaign.totalBudgetLimit) : null,
      totalUsedBudget: campaign.totalUsedBudget ? Number(campaign.totalUsedBudget) : 0,
      
      vouchers: campaign.vouchers ? campaign.vouchers.map((v: any) => ({
        ...v,
        id: v.id.toString(),
        campaignId: v.campaignId.toString(),
        discountValue: Number(v.discountValue),
        minPurchaseAmount: Number(v.minPurchaseAmount),
        maxDiscountAmount: v.maxDiscountAmount ? Number(v.maxDiscountAmount) : null,
      })) : undefined
    };
  }
}