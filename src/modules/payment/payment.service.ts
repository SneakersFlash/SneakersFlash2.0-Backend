import { Injectable, InternalServerErrorException, Logger, BadRequestException } from '@nestjs/common';
import * as MidtransClient from 'midtrans-client';
import * as crypto from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service'; // Wajib import ini
import { LogisticsService } from '../logistics/logistics.service';

@Injectable()
export class PaymentService {
  private snap: any;
  private readonly logger = new Logger(PaymentService.name);

  // Jangan lupa inject PrismaService!
  constructor(
    private prisma: PrismaService,
    private logisticsService: LogisticsService // <--- 2. INJECT INI
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
          order_id: order.orderNumber, // Midtrans membaca orderNumber kita sebagai order_id
          gross_amount: Number(order.finalAmount),
        },
        customer_details: {
          first_name: order.shippingRecipientName,
          email: 'customer@sneakersflash.com', // Opsional, sesuaikan dengan realita
          shipping_address: {
            first_name: order.shippingRecipientName,
            address: order.shippingAddressLine,
            city: order.shippingCity,
            postal_code: order.shippingPostalCode,
            country_code: 'IDN'
          }
        },
        item_details: order.orderItems.map(item => ({
          id: item.productVariantId.toString(),
          price: Number(item.price),
          quantity: item.quantity,
          name: item.productName.substring(0, 50) // Midtrans melimit nama barang 50 karakter
        })),
      };

      if (Number(order.shippingCost) > 0) {
        parameter.item_details.push({
          id: 'SHIP-COST',
          price: Number(order.shippingCost),
          quantity: 1,
          name: `Ongkir`
        });
      }

      const transaction = await this.snap.createTransaction(parameter);
      this.logger.log(`Snap Token Generated: ${transaction.token}`);
      return transaction.token;

    } catch (error) {
      this.logger.error('Midtrans Error:', error.message);
      throw new InternalServerErrorException('Gagal memproses pembayaran ke Midtrans');
    }
  }

  // 2. Handle Webhook / Notifikasi Midtrans
  async handleNotification(payload: any) {
    this.logger.log(`Terima Webhook Midtrans untuk Order: ${payload.order_id}`);

    const { order_id, status_code, gross_amount, signature_key, transaction_status, fraud_status, payment_type, transaction_id } = payload;
    const serverKey = process.env.MIDTRANS_SERVER_KEY;

    // A. Verifikasi Keamanan (Cek Signature Key)
    // Rumus Midtrans: SHA512(order_id + status_code + gross_amount + server_key)
    const expectedSignature = crypto
      .createHash('sha512')
      .update(order_id + status_code + gross_amount + serverKey)
      .digest('hex');

    // if (signature_key !== expectedSignature) {
    //   this.logger.error(`Signature tidak valid untuk Order: ${order_id}! Indikasi penipuan.`);
    //   throw new BadRequestException('Invalid signature key');
    // }

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

    // --- TAMBAHAN BARU: PANGGIL KOMERCE SAAT LUNAS ---
    let trackingNumber: string | null = null;
    let komerceOrderId: string | number | null = null;
    let pushToKomerceSuccess = false;

    if (newStatus === 'paid') {
      // Ambil data order utuh untuk dikirim ke Komerce
      const fullOrder = await this.prisma.order.findUnique({
        where: { orderNumber: order_id },
        include: { orderItems: true }
      });

      try {
        const komerceResult = await this.logisticsService.createShippingOrder(fullOrder);

        if (komerceResult) {
          trackingNumber = komerceResult.awb || komerceResult.order_no;
          komerceOrderId = komerceResult.order_id;
          newStatus = 'processing'; // Sukses push ke kurir
          pushToKomerceSuccess = true;
        } else {
          this.logger.error(`GAGAL PUSH KOMERCE: Order ${order_id} sudah dibayar tapi gagal create shipping.`);
          // Opsional: Kirim notif ke Admin via WA/Email manual di sini
        }
      } catch (e) {
        this.logger.error(`ERROR KOMERCE: ${e.message}`);
      }
    }

    // C. Update Tabel `Order` (Sesuaikan query updatenya)
    const order = await this.prisma.order.findUnique({
      where: { orderNumber: order_id }
    });

    if (!order) {
      this.logger.error(`Pesanan tidak ditemukan: ${order_id}`);
      throw new BadRequestException('Pesanan tidak ditemukan di database');
    }

    // Update DB beserta nomor resi komerce (jika ada)
    await this.prisma.order.update({
      where: { orderNumber: order_id },
      data: {
        status: newStatus,
        paymentStatus: transaction_status,
        paymentMethod: payment_type,
        paidAt: newStatus === 'paid' || newStatus === 'processing' ? new Date() : null,

        trackingNumber: trackingNumber ? trackingNumber : undefined,
        komerceOrderId: komerceOrderId ? komerceOrderId?.toString() : undefined,
      }
    });

    // D. Catat ke Tabel `PaymentLog` (Sesuai schema Anda yang proper)
    await this.prisma.paymentLog.create({
      data: {
        orderId: order.id,
        paymentType: payment_type,
        transactionId: transaction_id,
        transactionStatus: transaction_status,
        grossAmount: Number(gross_amount),
        rawResponse: payload, // Simpan mentahan dari Midtrans buat jaga-jaga audit
      }
    });

    this.logger.log(`Pesanan ${order_id} berhasil diupdate menjadi: ${newStatus}`);

    // Wajib balas dengan status 200 OK agar Midtrans tidak mengirim ulang notifikasi terus menerus
    return { status: 'success', message: 'Notification processed' };
  }
}