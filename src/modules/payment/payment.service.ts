import { Injectable, InternalServerErrorException, Logger, BadRequestException } from '@nestjs/common';
import * as MidtransClient from 'midtrans-client';
import * as crypto from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { LogisticsService } from '../logistics/logistics.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class PaymentService {
  private snap: any;
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private prisma: PrismaService,
    private logisticsService: LogisticsService,
    private notificationsService: NotificationsService,
    private usersService: UsersService,
  ) {
    this.snap = new MidtransClient.Snap({
      isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
      serverKey: process.env.MIDTRANS_SERVER_KEY,
      clientKey: process.env.MIDTRANS_CLIENT_KEY,
    });
  }

  // 1. Generate Snap Token (Ini sudah kita buat sebelumnya)
  async generateSnapToken(order: any) {
    try {
      const parameter = {
        transaction_details: {
          order_id: order.orderNumber,
          // Pastikan gross_amount diambil dari finalAmount yang sudah dikurangi diskon
          gross_amount: Math.round(Number(order.finalAmount)),
        },
        credit_card: {
          secure: true
        },
        customer_details: {
          first_name: order.shippingRecipientName,
          email: order.shippingEmail, // Bisa ambil dari user.email jika ada relasi
          phone: order.shippingPhone,
          shipping_address: {
            first_name: order.shippingRecipientName,
            address: order.shippingAddressLine,
            city: order.shippingCity,
            postal_code: order.shippingPostalCode,
            country_code: 'IDN'
          }
        },
        // 👇 PERUBAHAN UTAMA: 
        // Kita ambil langsung orderItems karena OrdersService sudah meraciknya 
        // (sudah termasuk Item Produk, Item Ongkir, dan Item Diskon Negatif)
        item_details: order.orderItems
      };

      const transaction = await this.snap.createTransaction(parameter);
      this.logger.log(`Snap Token Generated: ${transaction.token}`);
      return transaction.token;

    } catch (error: any) {
      this.logger.error('Midtrans Error:', error.message);
      // Log detail error dari Midtrans jika ada (biasanya array error_messages)
      if (error.ApiResponse) {
        this.logger.error('Midtrans API Response:', JSON.stringify(error.ApiResponse));
      }
      throw new InternalServerErrorException('Gagal memproses pembayaran ke Midtrans');
    }
  }

  // 2. Handle Webhook / Notifikasi Midtrans
  async handleNotification(payload: any) {
    this.logger.log(`Terima Webhook Midtrans untuk Order: ${payload.order_id}`);

    const { order_id, status_code, gross_amount, signature_key, transaction_status, fraud_status, payment_type, transaction_id } = payload;
    const serverKey = process.env.MIDTRANS_SERVER_KEY;

    // A. Verifikasi Keamanan (Cek Signature Key)
    const expectedSignature = crypto
      .createHash('sha512')
      .update(order_id + status_code + gross_amount + serverKey)
      .digest('hex');

    if (signature_key !== expectedSignature) {
      this.logger.error(`Signature tidak valid untuk Order: ${order_id}! Indikasi penipuan.`);
      throw new BadRequestException('Invalid signature key');
    }

    const order = await this.prisma.order.findUnique({
      where: { orderNumber: order_id },
      include: {
        orderItems: true,
        voucherUsages: true
      }
    });

    if (!order) {
      this.logger.warn(`Pesanan tidak ditemukan (mungkin test notification): ${order_id}`);
      return { status: 'ok', message: 'order not found, ignored' }; // tetap 200
    }

    // B. Tentukan Status Pesanan Kita
    let newStatus: any = 'pending';

    if (transaction_status == 'capture') {
      if (fraud_status == 'challenge') {
        newStatus = 'pending';
      } else if (fraud_status == 'accept') {
        newStatus = 'paid';
      }
    } else if (transaction_status == 'settlement') {
      newStatus = 'paid';
    } else if (transaction_status == 'cancel' || transaction_status == 'deny' || transaction_status == 'expire') {
      newStatus = 'cancelled';
    } else if (transaction_status == 'pending') {
      newStatus = 'waiting_payment';
    }

    // --- TAMBAHAN BARU: FITUR RESTORE STOCK (OPSI A) ---<s
    if (newStatus === 'cancelled' && order.status !== 'cancelled') {
      this.logger.warn(`Order ${order_id} dibatalkan (${transaction_status}). Mengembalikan stok & voucher...`);

      // Gunakan Transaction agar aman
      await this.prisma.$transaction(async (tx) => {
        // 1. Kembalikan Stok Barang
        for (const item of order.orderItems) {
          await tx.productVariant.update({
            where: { id: item.productVariantId },
            data: { stockQuantity: { increment: item.quantity } }
          });
          this.logger.log(`Stok variant ${item.productVariantId} dikembalikan +${item.quantity}`);
        }

        // 2. Kembalikan Voucher (Hapus riwayat pemakaian)
        if (order.voucherId) {
          await tx.voucherUsage.deleteMany({
            where: { orderId: order.id } // Hapus usage ID spesifik order ini
          });
          this.logger.log(`Voucher usage untuk Order ${order_id} dihapus (User bisa pakai lagi).`);
        }
      });
    }

    // --- LOGIC LAMA: PANGGIL KOMERCE SAAT LUNAS ---
    let trackingNumber: string | null = null;
    let komerceOrderId: string | number | null = null;

    // Cek: Status Paid DAN belum pernah diproses sebelumnya
    if (newStatus === 'paid' && order.status !== 'processing' && order.status !== 'shipped' && order.status !== 'paid') {

      try {
        // Kita pakai variabel 'order' yang sudah di-fetch di atas
        const komerceResult = await this.logisticsService.createShippingOrder(order);

        if (komerceResult) {
          trackingNumber = komerceResult.awb || komerceResult.order_no;
          komerceOrderId = komerceResult.order_no;
          newStatus = 'paid'; // Sukses push ke kurir -> Langsung Processing

          this.logger.log(`Auto-Pickup Sukses! Resi: ${trackingNumber}`);
        } else {
          this.logger.error(`GAGAL PUSH KOMERCE: Order ${order_id} gagal create shipping.`);
        }
      } catch (e: any) {
        this.logger.error(`ERROR KOMERCE: ${e.message}`);
      }
    }

    // C. Update Tabel `Order`
    await this.prisma.order.update({
      where: { orderNumber: order_id },
      data: {
        status: newStatus,
        paymentStatus: transaction_status,
        paidAt: newStatus === 'paid' || newStatus === 'processing' ? new Date() : undefined,

        trackingNumber: trackingNumber ? trackingNumber : undefined,
        komerceOrderId: komerceOrderId ? komerceOrderId?.toString() : undefined,
      }
    });

    if (newStatus === 'paid' || newStatus === 'processing') {
      const updatedOrder = await this.prisma.order.findUnique({
        where: { orderNumber: order_id },
        include: {
          user: true,
          orderItems: { include: { productVariant: { include: { product: true } } } }
        }
      });

      if (updatedOrder) {
        this.notificationsService.sendOrderInvoice(updatedOrder).catch(err =>
          this.logger.error(`Gagal kirim email invoice: ${err.message}`)
        );

        this.notificationsService.sendWarehouseAlert(
          updatedOrder.orderNumber,
          'LUNAS (Siap Diproses)',
          updatedOrder.orderItems,
          updatedOrder.courierName,
          updatedOrder.paidAt?.toISOString(),
          updatedOrder.komerceOrderId || '-'
        ).catch(err => this.logger.error(`Gagal kirim alert telegram: ${err.message}`));

        // Tambah poin berdasarkan tier user saat pembayaran lunas
        if (updatedOrder.user) {
          const user = updatedOrder.user;
          let pointPercentage = 0.01; // Basic 1%
          if (user.customerTier === 'advance') pointPercentage = 0.025;
          else if (user.customerTier === 'ultimate') pointPercentage = 0.05;

          const earnedPoints = Number(updatedOrder.finalAmount) * pointPercentage;

          await this.prisma.user.update({
            where: { id: updatedOrder.userId },
            data: { pointsBalance: { increment: earnedPoints } }
          });

          this.logger.log(`Poin +${earnedPoints} ditambahkan ke user ${user.id} (tier: ${user.customerTier})`);

          // Evaluasi dan update totalSpent + tier (background)
          this.usersService.evaluateCustomerTier(updatedOrder.userId).catch(err =>
            this.logger.error(`Gagal evaluasi tier user ${updatedOrder.userId}: ${err.message}`)
          );
        }
      }
    }

    // D. Catat ke Tabel `PaymentLog`
    await this.prisma.paymentLog.create({
      data: {
        orderId: order.id,
        paymentType: payment_type,
        transactionId: transaction_id,
        transactionStatus: transaction_status,
        grossAmount: Number(gross_amount),
        rawResponse: payload,
      }
    });

    this.logger.log(`Pesanan ${order_id} berhasil diupdate menjadi: ${newStatus}`);

    return { status: 'success', message: 'Notification processed' };
  }

  async getPaymentLogs(params: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    paymentType?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const page  = Math.max(1, params.page  ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const skip  = (page - 1) * limit;

    const where: any = {};

    if (params.status) {
      where.transactionStatus = params.status;
    }
    if (params.paymentType) {
      where.paymentType = { contains: params.paymentType, mode: 'insensitive' };
    }
    if (params.search) {
      where.OR = [
        { transactionId:  { contains: params.search, mode: 'insensitive' } },
        { order: { orderNumber: { contains: params.search, mode: 'insensitive' } } },
        { order: { shippingRecipientName: { contains: params.search, mode: 'insensitive' } } },
        { order: { user: { email: { contains: params.search, mode: 'insensitive' } } } },
      ];
    }
    if (params.dateFrom || params.dateTo) {
      where.createdAt = {
        ...(params.dateFrom && { gte: new Date(params.dateFrom) }),
        ...(params.dateTo   && { lte: new Date(new Date(params.dateTo).setHours(23, 59, 59, 999)) }),
      };
    }

    const [total, logs] = await Promise.all([
      this.prisma.paymentLog.count({ where }),
      this.prisma.paymentLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          order: {
            select: {
              orderNumber:          true,
              shippingRecipientName: true,
              finalAmount:          true,
              status:               true,
              user: { select: { name: true, email: true } },
            },
          },
        },
      }),
    ]);

    const data = logs.map((log) => ({
      id:                log.id.toString(),
      orderId:           log.orderId.toString(),
      orderNumber:       log.order.orderNumber,
      customerName:      log.order.shippingRecipientName,
      customerEmail:     log.order.user?.email ?? '-',
      orderStatus:       log.order.status,
      finalAmount:       Number(log.order.finalAmount),
      paymentType:       log.paymentType,
      transactionId:     log.transactionId,
      transactionStatus: log.transactionStatus,
      grossAmount:       log.grossAmount ? Number(log.grossAmount) : null,
      createdAt:         log.createdAt,
    }));

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async exportPaymentLogs(params: {
    search?: string;
    status?: string;
    paymentType?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<{ csv: string; filename: string }> {
    const where: any = {};

    if (params.status) {
      where.transactionStatus = params.status;
    }
    if (params.paymentType) {
      where.paymentType = { contains: params.paymentType, mode: 'insensitive' };
    }
    if (params.search) {
      where.OR = [
        { transactionId:  { contains: params.search, mode: 'insensitive' } },
        { order: { orderNumber: { contains: params.search, mode: 'insensitive' } } },
        { order: { shippingRecipientName: { contains: params.search, mode: 'insensitive' } } },
        { order: { user: { email: { contains: params.search, mode: 'insensitive' } } } },
      ];
    }
    if (params.dateFrom || params.dateTo) {
      where.createdAt = {
        ...(params.dateFrom && { gte: new Date(params.dateFrom) }),
        ...(params.dateTo   && { lte: new Date(new Date(params.dateTo).setHours(23, 59, 59, 999)) }),
      };
    }

    const logs = await this.prisma.paymentLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        order: {
          select: {
            orderNumber:          true,
            shippingRecipientName: true,
            finalAmount:          true,
            status:               true,
            user: { select: { name: true, email: true } },
          },
        },
      },
    });

    const fmtDate = (d: Date | null | undefined): string => {
      if (!d) return '-';
      return new Date(d.getTime() + 7 * 60 * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .substring(0, 19);
    };

    const esc = (val: any): string => {
      const str = val === null || val === undefined ? '' : String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    };

    const headers = [
      'ID Log',
      'No. Order',
      'Nama Customer',
      'Email Customer',
      'Status Order',
      'Total Akhir (Rp)',
      'Tipe Pembayaran',
      'Transaction ID (Midtrans)',
      'Status Transaksi',
      'Gross Amount (Rp)',
      'Tanggal Log (WIB)',
    ];

    const rows: string[] = [headers.join(',')];

    for (const log of logs) {
      rows.push([
        esc(log.id.toString()),
        esc(log.order.orderNumber),
        esc(log.order.shippingRecipientName),
        esc(log.order.user?.email ?? '-'),
        esc(log.order.status),
        esc(Number(log.order.finalAmount)),
        esc(log.paymentType ?? '-'),
        esc(log.transactionId ?? '-'),
        esc(log.transactionStatus ?? '-'),
        esc(log.grossAmount ? Number(log.grossAmount) : '-'),
        esc(fmtDate(log.createdAt)),
      ].join(','));
    }

    const csv = '﻿' + rows.join('\n');

    const now     = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    return { csv, filename: `payment-logs-${dateStr}.csv` };
  }
}