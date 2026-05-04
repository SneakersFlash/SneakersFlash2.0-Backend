import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateUserAddressDto } from './dto/create-user-address.dto';
import { UpdateUserAddressDto } from './dto/update-user-address.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { AdminQueryUserDto } from './dto/admin-query-user.dto';

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

  async adminFindAll(query: AdminQueryUserDto) {
    const { search, role, tier, isActive, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.UserWhereInput = {
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
        ],
      }),
      ...(role && { role }),
      ...(tier && { customerTier: tier }),
      ...(isActive !== undefined && { isActive }),
    };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true, name: true, email: true, phone: true, role: true,
          customerTier: true, pointsBalance: true, totalSpent: true,
          totalOrder: true, isActive: true, emailVerifiedAt: true, createdAt: true,
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async adminFindOne(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(id) },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        customerTier: true, pointsBalance: true, totalSpent: true,
        totalOrder: true, isActive: true, emailVerifiedAt: true,
        tierPeriodeStart: true, tierPeriodeEnd: true, createdAt: true,
        addresses: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] },
        _count: { select: { orders: true, reviews: true, wishlists: true } },
      },
    });
    if (!user) throw new NotFoundException('User tidak ditemukan');
    return user;
  }

  async adminUpdate(id: number, data: AdminUpdateUserDto) {
    await this.adminFindOne(id);
    return this.prisma.user.update({
      where: { id: BigInt(id) },
      data: {
        name: data.name,
        phone: data.phone,
        role: data.role,
        customerTier: data.customerTier,
        isActive: data.isActive,
        ...(data.pointsBalance !== undefined && { pointsBalance: data.pointsBalance }),
      },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        customerTier: true, isActive: true, pointsBalance: true,
      },
    });
  }

  async adminToggleStatus(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(id) },
      select: { id: true, isActive: true, name: true, email: true },
    });
    if (!user) throw new NotFoundException('User tidak ditemukan');

    return this.prisma.user.update({
      where: { id: BigInt(id) },
      data: { isActive: !user.isActive },
      select: { id: true, name: true, email: true, isActive: true },
    });
  }

  async adminDelete(id: number) {
    await this.adminFindOne(id);
    await this.prisma.user.delete({ where: { id: BigInt(id) } });
    return { message: 'User berhasil dihapus' };
  }

  async adminResetPassword(id: number, newPassword: string) {
    await this.adminFindOne(id);
    const hashed = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: BigInt(id) },
      data: { password: hashed },
    });
    return { message: 'Password berhasil direset' };
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