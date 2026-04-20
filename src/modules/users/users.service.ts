import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateUserAddressDto } from './dto/create-user-address.dto';
import { UpdateUserAddressDto } from './dto/update-user-address.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  // ==========================================
  // 1. CUSTOMER PROFILE
  // ==========================================

  async findMyProfile(id: number | bigint) {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(id) },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        customerTier: true, pointsBalance: true, createdAt: true,
        addresses: {
          where: { isDefault: true },
          take: 1,
        }
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateMyProfile(id: number | bigint, data: UpdateUserDto) {
    return this.prisma.user.update({
      where: { id: BigInt(id) },
      data: { name: data.name, phone: data.phone }, // Hanya izinkan update nama & telepon
      select: { id: true, name: true, email: true, phone: true }
    });
  }

  // ==========================================
  // 2. CUSTOMER ADDRESSES
  // ==========================================

  async getMyAddresses(userId: number | bigint) {
    return this.prisma.userAddress.findMany({
      where: { userId: BigInt(userId) },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      // include: { province: true, city: true, district: true }
    });
  }

  async getMyAddress(userId: number | bigint, addressId: number) {
    const address = await this.prisma.userAddress.findFirst({
      where: {
        id: BigInt(addressId),
        userId: BigInt(userId),
      },
      // Uncomment if you need the relations loaded:
      // include: { province: true, city: true, district: true }
    });

    if (!address) {
      throw new NotFoundException('Address not found');
    }

    return address;
  }
  
  async addMyAddress(userId: number | bigint, data: CreateUserAddressDto) {
    const existingCount = await this.prisma.userAddress.count({
      where: { userId: BigInt(userId) }
    });
    
    // Otomatis jadikan default jika ini alamat pertama
    const isDefault = data.isDefault || existingCount === 0;

    // Jika set default, matikan default alamat lain
    if (isDefault && existingCount > 0) {
      await this.prisma.userAddress.updateMany({
        where: { userId: BigInt(userId), isDefault: true },
        data: { isDefault: false }
      });
    }

    return this.prisma.userAddress.create({
      data: { ...data, isDefault, userId: BigInt(userId) }
    });
  }

  async updateMyAddress(userId: number | bigint, addressId: number, data: UpdateUserAddressDto) {
    if (data.isDefault) {
      await this.prisma.userAddress.updateMany({
        where: { userId: BigInt(userId), isDefault: true, id: { not: BigInt(addressId) } },
        data: { isDefault: false }
      });
    }

    return this.prisma.userAddress.update({
      where: { id: BigInt(addressId), userId: BigInt(userId) },
      data
    });
  }

  async deleteMyAddress(userId: number | bigint, addressId: number) {
    return this.prisma.userAddress.delete({
      where: { id: BigInt(addressId), userId: BigInt(userId) }
    });
  }

  // ==========================================
  // 3. ADMIN ENDPOINTS
  // ==========================================

  async findAll() {
    return this.prisma.user.findMany({
      select: { id: true, name: true, email: true, role: true, phone: true, createdAt: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  async findOne(id: number) {
    return this.prisma.user.findUnique({ where: { id: BigInt(id) } });
  }


  async evaluateCustomerTier(userId: bigint | number) {
  // 1. Tentukan tanggal 6 bulan yang lalu dari sekarang
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  // 2. Hitung (sum) seluruh total belanja (finalAmount) dengan status 'completed'
  const aggregateResult = await this.prisma.order.aggregate({
    where: {
      userId: BigInt(userId),
      status: 'completed',
      createdAt: { gte: sixMonthsAgo } // Filter 6 bulan terakhir
    },
    _sum: {
      finalAmount: true
    }
  });

  const totalSpent = Number(aggregateResult._sum.finalAmount || 0);

  // 3. Tentukan Tier Baru
  let newTier = 'basic';
  if (totalSpent >= 10000000) { // Rp 10.000.000
    newTier = 'ultimate';
  } else if (totalSpent >= 5000000) { // Rp 5.000.000
    newTier = 'advance';
  }

  // 4. Tarik data user untuk dicek apakah tier-nya berubah
  const user = await this.prisma.user.findUnique({ where: { id: BigInt(userId) } });
  
  // Jika berubah, update database
  if (user && user.customerTier !== newTier) {
    await this.prisma.user.update({
      where: { id: BigInt(userId) },
      data: { customerTier: newTier }
    });
    
    // Opsional: Buat Notifikasi ke tabel Notification kalau user naik/turun level
  }
}
}