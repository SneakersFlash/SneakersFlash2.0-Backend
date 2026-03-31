import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentService } from '../payment/payment.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderStatus, Prisma } from '@prisma/client';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private prisma: PrismaService,
    private paymentService: PaymentService
  ) { }

  async checkout(userId: number, dto: CreateOrderDto) {
    this.logger.log(`Memulai proses checkout untuk User ID: ${userId}`);

    // 1. Validasi input dari frontend
    if (!dto.cartItemIds || dto.cartItemIds.length === 0) {
      throw new BadRequestException('Tidak ada barang yang dipilih untuk dicheckout.');
    }

    // Convert string ID dari frontend ke BigInt (jika skema DB Anda pakai BigInt untuk ID cart item)
    // Jika ID Anda berupa Int biasa di Prisma, ganti BigInt() jadi Number()
    const selectedCartItemIds = dto.cartItemIds.map(id => BigInt(id));

    // 2. 👈 PENTING: Ambil Keranjang, TAPI HANYA ITEM YANG DIPILIH
    const cart = await this.prisma.cart.findUnique({
      where: { userId: BigInt(userId) },
      include: {
        user: true,
        cartItems: {
          where: {
            id: { in: selectedCartItemIds } // 争 Filter hanya yang dicentang
          },
          include: { variant: { include: { product: true } } }
        }
      }
    });

    if (!cart || cart.cartItems.length === 0) {
      throw new BadRequestException('Barang yang dipilih tidak ditemukan di keranjang!');
    }

    // 3. Hitung Total & Siapkan Data Snapshot
    let subtotal = 0;
    let totalWeight = 0;
    const orderItemsData: any = [];

    for (const item of cart.cartItems) {
      if (item.variant.stockQuantity < item.quantity) {
        throw new BadRequestException(`Stok ${item.variant.product.name} habis/kurang! Sisa: ${item.variant.stockQuantity}`);
      }

      const price = Number(item.variant.price);
      const itemSubtotal = price * item.quantity;
      subtotal += itemSubtotal;
      totalWeight += (item.variant.product.weightGrams * item.quantity);

      orderItemsData.push({
        productVariantId: item.productVariantId,
        productName: item.variant.product.name,
        variantName: item.variant.sku,
        sku: item.variant.sku,
        price: item.variant.price,
        quantity: item.quantity,
        subtotal: itemSubtotal,
      });
    }

    // ==========================================
    // 4. LOGIC VOUCHER & DISKON (Biarkan persis seperti kode Anda sebelumnya)
    // ==========================================
    let discountTotal = 0;
    let voucherId: bigint | null = null;
    let voucherCode: string | null = null;

    if (dto.voucherCode) {
      const voucher = await this.prisma.voucher.findUnique({
        where: { code: dto.voucherCode, isActive: true }
      });

      if (!voucher) throw new BadRequestException('Voucher tidak ditemukan atau sudah tidak aktif.');

      const now = new Date();
      if (now < voucher.startAt || now > voucher.expiresAt) {
        throw new BadRequestException('Voucher belum dimulai atau sudah kedaluwarsa.');
      }

      if (voucher.usageLimitTotal !== null) {
        const totalUsage = await this.prisma.voucherUsage.count({ where: { voucherId: voucher.id } });
        if (totalUsage >= voucher.usageLimitTotal) {
          throw new BadRequestException('Kuota voucher ini sudah habis.');
        }
      }

      const userUsage = await this.prisma.voucherUsage.count({
        where: { voucherId: voucher.id, userId: BigInt(userId) }
      });
      if (userUsage >= voucher.usageLimitPerUser) {
        throw new BadRequestException('Anda sudah mencapai batas penggunaan voucher ini.');
      }

      if (subtotal < Number(voucher.minPurchaseAmount)) {
        throw new BadRequestException(`Total belanja kurang. Minimal: Rp ${Number(voucher.minPurchaseAmount)}`);
      }

      if (voucher.discountType === 'fixed_amount') {
        discountTotal = Number(voucher.discountValue);
      } else if (voucher.discountType === 'percentage') {
        discountTotal = (subtotal * Number(voucher.discountValue)) / 100;
        if (voucher.maxDiscountAmount !== null) {
          discountTotal = Math.min(discountTotal, Number(voucher.maxDiscountAmount));
        }
      }

      discountTotal = Math.min(discountTotal, subtotal);
      voucherId = voucher.id;
      voucherCode = voucher.code;

      this.logger.log(`Voucher Applied: ${voucher.code}, Discount: ${discountTotal}`);
    }

    const shippingCost = dto.courier.cost;
    const taxAmount = 0;
    const finalAmount = subtotal + shippingCost + taxAmount - discountTotal;
    const finalWeightGrams = Math.max(1000, totalWeight);
    const orderNumber = `ORD-${Date.now()}-${userId}`;

    try {
      return await this.prisma.$transaction(async (tx) => {

        // A. Buat Header Order (Persis seperti kode Anda)
        const newOrder = await tx.order.create({
          data: {
            userId: BigInt(userId),
            orderNumber: orderNumber,
            status: 'pending',

            shippingRecipientName: dto.address.recipientName,
            shippingPhone: dto.address.phone,
            shippingAddressLine: dto.address.addressLine,
            shippingSubdistrictId: dto.address.subdistrictId,
            shippingCity: dto.address.city,
            shippingPostalCode: dto.address.postalCode,

            shippingLatitude: dto.address.latitude,
            shippingLongitude: dto.address.longitude,

            courierName: dto.courier.name,
            courierService: dto.courier.service,
            shippingCost: shippingCost,
            totalWeightGrams: finalWeightGrams,

            subtotal: subtotal,
            taxAmount: taxAmount,
            discountTotal: discountTotal,
            finalAmount: finalAmount,
            paymentMethod: dto.paymentMethod,

            voucherId: voucherId,
            voucherCode: voucherCode,

            orderItems: {
              create: orderItemsData
            }
          },
          include: { orderItems: true }
        });

        // B. Catat penggunaan voucher (Persis seperti kode Anda)
        if (voucherId) {
          await tx.voucherUsage.create({
            data: {
              userId: BigInt(userId),
              voucherId: voucherId,
              orderId: newOrder.id,
              discountAmount: discountTotal
            }
          });
        }

        // C. Potong Stok Varian (Persis seperti kode Anda)
        for (const item of cart.cartItems) {
          await tx.productVariant.update({
            where: { id: item.productVariantId },
            data: { stockQuantity: { decrement: item.quantity } }
          });
        }

        await tx.cartItem.deleteMany({
          where: { 
            id: { in: selectedCartItemIds }
          }
        });

        const orderForMidtrans = {
          ...newOrder,
          id: newOrder.id.toString(),
          shippingCost: Number(newOrder.shippingCost),
          finalAmount: Number(newOrder.finalAmount),
          orderItems: orderItemsData
        };

        const chargeResponse = await this.chargeCoreApi( 
          orderForMidtrans, 
          dto.paymentMethod as string, 
          {
              firstName: dto.address.recipientName,
              phone: dto.address.phone,
              email: cart.user.email 
          }
        );

        // Ekstrak Nomor VA / URL QR Code dari response Midtrans
        let paymentStatus = chargeResponse.transaction_status || 'pending';
        let vaNumber: any = null;
        let qrCodeUrl: any = null;
        let deepLinkUrl: any = null;

        if (chargeResponse.va_numbers?.length > 0) {
          vaNumber = chargeResponse.va_numbers[0].va_number;
        } else if (dto.paymentMethod === 'mandiri_va') {
          vaNumber = `${chargeResponse.biller_code}|${chargeResponse.bill_key}`;
        }

        // ✅ Untuk QRIS dan GoPay — ambil dari actions array
        if (chargeResponse.actions?.length > 0) {
          const qrAction = chargeResponse.actions.find(
            (a: any) => a.name === 'generate-qr-code'
          );
          const deepLinkAction = chargeResponse.actions.find(
            (a: any) => a.name === 'deeplink-redirect'
          );
          qrCodeUrl = qrAction?.url || null;
          deepLinkUrl = deepLinkAction?.url || null;
        }

        // F. Update Order dengan Data Pembayaran Mentah
        // NOTE: Anda perlu menambahkan field vaNumber dan qrCodeUrl di schema.prisma
        const finalOrder = await tx.order.update({
          where: { id: newOrder.id },
          data: { 
            vaNumber: vaNumber,      
            qrCodeUrl: qrCodeUrl,  
            status: paymentStatus === 'settlement' ? 'paid' : 'pending',
            // paymentMetadata: chargeResponse // (Opsional) Simpan raw JSON response jika butuh
          }
        });

        this.logger.log(`Checkout Sukses! Order: ${orderNumber}, VA/QR: ${vaNumber || 'QRIS'}`);

        return {
          id: finalOrder.id.toString(),
          orderNumber: finalOrder.orderNumber,
          status: finalOrder.status,
          finalAmount: Number(finalOrder.finalAmount),
          paymentMethod: dto.paymentMethod,
          vaNumber: vaNumber,
          qrCodeUrl: qrCodeUrl,
          expireTime: chargeResponse.expiry_time // Kirim batas waktu bayar ke frontend
        };
      });

    } catch (error: any) {
      this.logger.error(`Gagal melakukan checkout: ${error.message}`);
      throw new InternalServerErrorException(error.message || 'Terjadi kesalahan saat memproses pesanan.');
    }
  }

  // Lihat Order Saya (History)
  async getMyOrders(userId: number) {
    const orders = await this.prisma.order.findMany({
      where: { userId: BigInt(userId) },
      orderBy: { createdAt: 'desc' },
      include: {
        orderItems: {
          include: {
            productVariant: true
            }
        }
      }
    });

    return orders.map(o => ({
      ...o,
      id: o.id.toString(),
      userId: o.userId.toString(),
      subtotal: Number(o.subtotal),
      shippingCost: Number(o.shippingCost),
      finalAmount: Number(o.finalAmount),
      discountTotal: Number(o.discountTotal),
      voucherId: o.voucherId ? o.voucherId.toString() : null,
      orderItems: o.orderItems.map(item => ({
        ...item,
        id: item.id.toString(),
        orderId: item.orderId.toString(),
        productVariantId: item.productVariantId.toString(),
        price: Number(item.price),
        subtotal: Number(item.subtotal),
        imageUrl: item.productVariant?.imageUrl?.[0] || null
      }))
    }));
  }

  async findAllForAdmin(params: { page: number; limit: number; status?: string; search?: string; sortBy?: string; sortOrder?: 'asc' | 'desc' }) {
    const { page, limit, status, search, sortBy = 'createdAt', sortOrder = 'desc' } = params;
    const skip = (page - 1) * limit;
    
    // Konfigurasi Filter Pencarian
    const whereClause: Prisma.OrderWhereInput = {};
    
    if (status) {
      whereClause.status = status as OrderStatus;
    }

    if (search) {
      whereClause.OR = [
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    // Eksekusi Query
    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where: whereClause }),
      this.prisma.order.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          user: { select: { name: true, email: true, phone: true } },
          orderItems: { include: { productVariant: { include: { product: true } } } } // Ambil relasi untuk gambar & size
        }
      })
    ]);

    const lastPage = Math.ceil(total / limit);

    return {
      data: orders.map(o => this.formatOrderForResponse(o)),
      meta: {
        total,
        page,
        limit,
        lastPage,
        hasNextPage: page < lastPage,
        hasPrevPage: page > 1
      }
    };
  }

  async findOneForAdmin(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: BigInt(id) },
      include: {
        user: { select: { name: true, email: true, phone: true } },
        orderItems: { include: { productVariant: { include: { product: true } } } } // Ambil relasi untuk gambar & size
      }
    });

    if (!order) throw new NotFoundException('Order tidak ditemukan');

    return this.formatOrderForResponse(order);
  }

  async updateOrderStatus(id: string, status: string, trackingNumber?: string) {
    // Karena frontend memanggil PATCH status dengan status 'CANCELLED' untuk membatalkan pesanan,
    // kita alihkan logikanya ke fungsi cancel agar stok dikembalikan.
    if (status === 'CANCELLED') {
      return this.cancelOrderAdmin(id);
    }

    try {
      const updatedOrder = await this.prisma.order.update({
        where: { id: BigInt(id) },
        data: { 
          status: status as OrderStatus, 
          ...(trackingNumber && { trackingNumber })
        },
        include: {
          user: { select: { name: true, email: true, phone: true } },
          orderItems: { include: { productVariant: { include: { product: true } } } }
        }
      });

      this.logger.log(`Status order ${id} diubah menjadi ${status}`);
      return this.formatOrderForResponse(updatedOrder);
    } catch (error) {
      throw new InternalServerErrorException('Gagal update status order');
    }
  }

  // Fungsi internal untuk memproses pembatalan pesanan (mengembalikan stok)
  private async cancelOrderAdmin(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: BigInt(id) },
      include: { orderItems: true }
    });

    if (!order) throw new NotFoundException('Order tidak ditemukan');

    if (order.status === ('SHIPPED' as OrderStatus) || order.status === ('DELIVERED' as OrderStatus)) {
      throw new BadRequestException('Order yang sudah dikirim atau selesai tidak dapat dibatalkan.');
    }
    if (order.status === ('CANCELLED' as OrderStatus)) {
      throw new BadRequestException('Order ini sudah dibatalkan sebelumnya.');
    }

    try {
      const cancelledOrder = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.order.update({
          where: { id: BigInt(id) },
          data: { status: 'CANCELLED' as OrderStatus },
          include: {
            user: { select: { name: true, email: true, phone: true } },
            orderItems: { include: { productVariant: { include: { product: true } } } }
          }
        });

        // Kembalikan (Increment) stok produk varian
        for (const item of order.orderItems) {
          await tx.productVariant.update({
            where: { id: item.productVariantId },
            data: { stockQuantity: { increment: item.quantity } }
          });
        }

        return updated;
      });

      this.logger.log(`Order ${id} dibatalkan. Stok berhasil dikembalikan.`);
      return this.formatOrderForResponse(cancelledOrder);
    } catch (error) {
      this.logger.error(`Gagal membatalkan order ${id}:`, error);
      throw new InternalServerErrorException('Terjadi kesalahan saat membatalkan order');
    }
  }

  // ==========================================
  // INTEGRASI KOMERCE
  // ==========================================

  async processKomerceShipment(orderId: string) {
    // 1. Ambil Data Order Lengkap
    const order = await this.prisma.order.findUnique({
      where: { id: BigInt(orderId) },
      include: { orderItems: true }
    });

    if (!order) throw new NotFoundException('Order tidak ditemukan');
    
    // Validasi apakah sudah dibayar (tergantung alur bisnismu)
    if (order.status !== 'paid') {
      throw new BadRequestException('Order belum dibayar, tidak bisa request pickup');
    }

    // 2. Siapkan Payload untuk API Komerce
    // Dokumentasi: https://api.komerce.id/docs
    const komercePayload = {
      is_cod: 0, // 0 = Non-COD, 1 = COD
      payment_method: 'bank_transfer', 
      shipment_method: 'pickup', // pickup / dropoff
      tariff_code: order.courierService, // ex: REG, YES, OKE
      destination: {
        subdistrict_id: order.shippingSubdistrictId,
        customer_name: order.shippingRecipientName,
        customer_phone: order.shippingPhone,
        detail_address: order.shippingAddressLine,
      },
      items: order.orderItems.map(item => ({
        name: item.productName,
        qty: item.quantity,
        price: Number(item.price),
      })),
      weight: order.totalWeightGrams,
    };

    try {
      this.logger.log(`Mengirim request pickup ke Komerce untuk Order: ${order.orderNumber}`);

      // 3. Tembak API Komerce (Contoh menggunakan fetch, sesuaikan dengan HttpService jika mau)
      /*
      const response = await fetch('https://api.komerce.id/v1/shipment/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.KOMERCE_API_KEY}` 
        },
        body: JSON.stringify(komercePayload)
      });
      const data = await response.json();
      */

      // --- MOCK RESPONSE UNTUK CONTOH ---
      const mockKomerceResponse = {
        status: 'success',
        data: {
          awb: `KMR-${Date.now()}`, // Resi dari Komerce
          shipment_status: 'pickup_requested'
        }
      };
      // ----------------------------------

      if (mockKomerceResponse.status !== 'success') {
          throw new Error('Gagal dari sisi Komerce');
      }

      // 4. Update Database dengan Resi (AWB) dari Komerce & Ubah Status
      const updatedOrder = await this.prisma.order.update({
        where: { id: BigInt(orderId) },
        data: {
          trackingNumber: mockKomerceResponse.data.awb, // Tambahkan field ini di schema Prisma jika belum ada
          status: 'processing' // Atau 'shipped'
        }
      });

      return {
        message: 'Berhasil request pickup Komerce',
        resi: updatedOrder.trackingNumber,
        order: this.formatOrderForResponse(updatedOrder)
      };

    } catch (error: any) {
      this.logger.error(`Komerce Error: ${error.message}`);
      throw new InternalServerErrorException('Gagal melakukan integrasi dengan pengiriman');
    }
  }

  // ==========================================
  // UTILS
  // ==========================================
  
  // Helper untuk membersihkan BigInt agar aman saat di-return sebagai JSON
  private formatOrderForResponse(order: any) {
    return {
      id: order.id.toString(),
      orderNumber: order.orderNumber,
      status: order.status,
      createdAt: order.createdAt,
      paidAt: order.paidAt || null, 
      paymentMethod: order.paymentMethod,
      vaNumber: order.vaNumber || null,
      qrCodeUrl: order.qrCodeUrl || null,
      voucherCode: order.voucherCode,
      
      // Mapping nama field agar cocok dengan frontend
      discountAmount: Number(order.discountTotal || 0),
      subtotal: Number(order.subtotal || 0),
      shippingCost: Number(order.shippingCost || 0),
      total: Number(order.finalAmount || 0), // finalAmount di DB -> total di frontend

      user: order.user ? {
        name: order.user.name,
        email: order.user.email,
        phone: order.user.phone || '-'
      } : null,

      // Dikelompokkan ke dalam object address
      address: {
        recipientName: order.shippingRecipientName,
        phone: order.shippingPhone,
        street: order.shippingAddressLine,
        subdistrict: order.shippingSubdistrictId?.toString() || '',
        city: order.shippingCity,
        province: order.shippingProvince || '', // Pastikan ada di DB jika ingin ditampilkan
        postalCode: order.shippingPostalCode,
        notes: order.shippingNotes || ''
      },

      // Dikelompokkan ke dalam object courier
      courier: {
        name: order.courierName,
        service: order.courierService,
        cost: Number(order.shippingCost || 0),
        trackingNumber: order.trackingNumber || ''
      },

      // Mapping orderItems menjadi items
      items: order.orderItems ? order.orderItems.map((item: any) => ({
        id: item.id.toString(),
        productName: item.productName,
        variantSku: item.variantName || item.sku || '-',
        size: item.variant?.size || '-', // Pastikan tabel variant punya field size
        quantity: item.quantity,
        unitPrice: Number(item.price),
        subtotal: Number(item.subtotal),
        // Ambil imageUrl dari relasi product jika tersedia di Prisma schema kamu
        imageUrl: item.productVariant?.imageUrl?.[0] || null 
      })) : []
    };
  }

  async chargeCoreApi(order: any, paymentMethod: string, customerDetails: any) {
    const coreApiUrl = process.env.MIDTRANS_IS_PRODUCTION === 'true'
      ? 'https://api.midtrans.com/v2/charge'
      : 'https://api.sandbox.midtrans.com/v2/charge';

    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const authString = Buffer.from(`${serverKey}:`).toString('base64');

    const itemDetails = order.orderItems.map((item: any) => ({
      id: item.productVariantId?.toString() || 'ITEM',
      price: Math.round(Number(item.price)),
      quantity: item.quantity,
      name: item.productName.substring(0, 50),
    }));

    itemDetails.push({
      id: 'SHIPPING',
      price: Math.round(order.shippingCost),
      quantity: 1,
      name: 'Ongkos Kirim',
    });

    if (order.discountTotal && Number(order.discountTotal) > 0) {
      itemDetails.push({
        id: 'DISCOUNT',
        price: -Math.round(Number(order.discountTotal)), 
        quantity: 1,
        name: 'Diskon Voucher',
      });
    }

    const payload: any = {
      transaction_details: {
        order_id: order.orderNumber,
        gross_amount: Math.round(order.finalAmount), 
      },
      customer_details: {
        first_name: customerDetails.firstName,
        email: customerDetails.email,
        phone: customerDetails.phone,
      },
      item_details: itemDetails,
    };

    // ─── BANK TRANSFER ───────────────────────────────────────────
    if (paymentMethod === 'bca_va') {
      payload.payment_type = 'bank_transfer';
      payload.bank_transfer = { bank: 'bca' };

    } else if (paymentMethod === 'bni_va') {
      payload.payment_type = 'bank_transfer';
      payload.bank_transfer = { bank: 'bni' };

    } else if (paymentMethod === 'bri_va') {
      payload.payment_type = 'bank_transfer';
      payload.bank_transfer = { bank: 'bri' };

    } else if (paymentMethod === 'mandiri_va') {
      payload.payment_type = 'echannel';
      payload.echannel = {
        bill_info1: 'Pembayaran',
        bill_info2: order.orderNumber,
      };

    // ─── QRIS ─────────────────────────────────────────────────────
    } else if (paymentMethod === 'qris') {
      payload.payment_type = 'qris';
      payload.qris = { acquirer: 'gopay' };

    // ─── GOPAY → redirect ke QRIS (GoPay POP butuh partnership khusus) ───
    } else if (paymentMethod === 'gopay') {
      payload.payment_type = 'qris';
      payload.qris = { acquirer: 'gopay' }
    } else if (paymentMethod === 'shopeepay') {
      payload.payment_type = 'shopeepay';
      payload.shopeepay = {
        callback_url: process.env.MIDTRANS_SHOPEEPAY_CALLBACK_URL || 'https://yourapp.com/payment/finish',
      };

    } else {
      throw new BadRequestException(`Payment method '${paymentMethod}' tidak didukung.`);
    }

    this.logger.log(`[Midtrans] Charging payload: ${JSON.stringify(payload)}`);

    const response = await fetch(coreApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Basic ${authString}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    this.logger.log(`[Midtrans] Response status_code: ${data.status_code}`);
    this.logger.log(`[Midtrans] Full response: ${JSON.stringify(data)}`);

    const successCodes = ['200', '201'];
    if (!successCodes.includes(data.status_code)) {
      this.logger.error(`[Midtrans] FAILED — status: ${data.status_code}, message: ${data.status_message}`);
      throw new InternalServerErrorException(`Midtrans Error: ${data.status_message}`);
    }

    return data;
  }

  async cancelOrderClient(id: string, userId: number) {
    const order = await this.prisma.order.findUnique({
      where: { id: BigInt(id) },
      include: { orderItems: true }
    });

    if (!order) throw new NotFoundException('Order tidak ditemukan');

    if (order.userId !== BigInt(userId)) {
      throw new BadRequestException('Akses ditolak. Anda tidak berhak membatalkan pesanan ini.');
    }

    if (order.status !== 'pending' && order.status !== 'waiting_payment') {
      throw new BadRequestException('Pesanan tidak dapat dibatalkan karena pembayaran sudah diterima atau pesanan sedang diproses.');
    }

    try {
      const cancelledOrder = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.order.update({
          where: { id: BigInt(id) },
          data: { status: 'cancelled' as OrderStatus }, 
          include: {
            user: { select: { name: true, email: true, phone: true } },
            orderItems: { include: { productVariant: { include: { product: true } } } }
          }
        });

        for (const item of order.orderItems) {
          await tx.productVariant.update({
            where: { id: item.productVariantId },
            data: { stockQuantity: { increment: item.quantity } }
          });
        }

        return updated;
      });

      this.logger.log(`Order ${id} berhasil dibatalkan oleh customer ${userId}. Stok dikembalikan.`);
      return this.formatOrderForResponse(cancelledOrder);
    } catch (error) {
      this.logger.error(`Gagal membatalkan order ${id} oleh user:`, error);
      throw new InternalServerErrorException('Terjadi kesalahan saat membatalkan pesanan.');
    }
  }
}