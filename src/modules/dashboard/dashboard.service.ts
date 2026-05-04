import { Injectable } from '@nestjs/common';
import { OrderStatus, Role } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

const LOW_STOCK_THRESHOLD = 5;

const PAID_STATUSES: OrderStatus[] = [
  OrderStatus.paid,
  OrderStatus.processing,
  OrderStatus.shipped,
  OrderStatus.delivered,
  OrderStatus.completed,
];

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getStats() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    const [
      totalRevenue,
      revenueToday,
      revenueYesterday,
      totalOrders,
      ordersToday,
      ordersYesterday,
      totalUsers,
      newUsersToday,
      lowStockCount,
      pendingOrdersCount,
    ] = await Promise.all([
      this.prisma.order.aggregate({
        _sum: { finalAmount: true },
        where: { status: { in: PAID_STATUSES } },
      }),
      this.prisma.order.aggregate({
        _sum: { finalAmount: true },
        where: { status: { in: PAID_STATUSES }, paidAt: { gte: todayStart } },
      }),
      this.prisma.order.aggregate({
        _sum: { finalAmount: true },
        where: {
          status: { in: PAID_STATUSES },
          paidAt: { gte: yesterdayStart, lt: todayStart },
        },
      }),
      this.prisma.order.count(),
      this.prisma.order.count({ where: { createdAt: { gte: todayStart } } }),
      this.prisma.order.count({ where: { createdAt: { gte: yesterdayStart, lt: todayStart } } }),
      this.prisma.user.count({ where: { role: Role.customer } }),
      this.prisma.user.count({ where: { role: Role.customer, createdAt: { gte: todayStart } } }),
      this.prisma.productVariant.count({
        where: { availableStock: { lte: LOW_STOCK_THRESHOLD }, isActive: true },
      }),
      this.prisma.order.count({ where: { status: OrderStatus.paid } }),
    ]);

    const totalRev = Number(totalRevenue._sum.finalAmount ?? 0);
    const todayRev = Number(revenueToday._sum.finalAmount ?? 0);
    const yesterdayRev = Number(revenueYesterday._sum.finalAmount ?? 0);

    const calcGrowth = (today: number, yesterday: number) =>
      yesterday === 0 ? (today > 0 ? 100 : 0) : parseFloat((((today - yesterday) / yesterday) * 100).toFixed(1));

    return {
      totalRevenue: totalRev,
      revenueToday: todayRev,
      revenueGrowth: calcGrowth(todayRev, yesterdayRev),
      totalOrders,
      ordersToday,
      ordersGrowth: calcGrowth(ordersToday, ordersYesterday),
      totalUsers,
      newUsersToday,
      lowStockCount,
      pendingOrdersCount,
    };
  }

  async getRevenueChart(days = 7) {
    const rangeStart = new Date();
    rangeStart.setHours(0, 0, 0, 0);
    rangeStart.setDate(rangeStart.getDate() - (days - 1));

    const [paidOrders, allOrders] = await Promise.all([
      this.prisma.order.findMany({
        where: { status: { in: PAID_STATUSES }, paidAt: { gte: rangeStart } },
        select: { paidAt: true, finalAmount: true },
      }),
      this.prisma.order.findMany({
        where: { createdAt: { gte: rangeStart } },
        select: { createdAt: true },
      }),
    ]);

    const result: { date: string; revenue: number; orders: number }[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      dayStart.setDate(dayStart.getDate() - i);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const revenue = paidOrders
        .filter((o) => o.paidAt && o.paidAt >= dayStart && o.paidAt < dayEnd)
        .reduce((sum, o) => sum + Number(o.finalAmount), 0);

      const orders = allOrders.filter(
        (o) => o.createdAt >= dayStart && o.createdAt < dayEnd,
      ).length;

      result.push({
        date: dayStart.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }),
        revenue,
        orders,
      });
    }

    return result;
  }

  async getOrderStatusDistribution() {
    const STATUS_LABELS: Record<string, string> = {
      pending: 'Pending',
      waiting_payment: 'Menunggu Bayar',
      paid: 'Dibayar',
      processing: 'Diproses',
      shipped: 'Dikirim',
      delivered: 'Terkirim',
      completed: 'Selesai',
      cancelled: 'Dibatalkan',
      returned: 'Dikembalikan',
    };

    const groups = await this.prisma.order.groupBy({
      by: ['status'],
      _count: { id: true },
    });

    return groups.map((g) => ({
      status: g.status,
      label: STATUS_LABELS[g.status] ?? g.status,
      count: g._count.id,
    }));
  }
}
