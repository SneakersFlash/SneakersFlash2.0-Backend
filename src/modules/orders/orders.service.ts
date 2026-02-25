import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentService } from '../payment/payment.service';
import { CreateOrderDto } from './dto/create-order.dto';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private prisma: PrismaService,
    private paymentService: PaymentService
  ) { }

  async checkout(userId: number, dto: CreateOrderDto) {
    this.logger.log(`Memulai proses checkout untuk User ID: ${userId}`);

    // 1. Ambil Keranjang User
    const cart = await this.prisma.cart.findUnique({
      where: { userId: BigInt(userId) },
      include: {
        cartItems: {
          include: { variant: { include: { product: true } } }
        }
      }
    });

    if (!cart || cart.cartItems.length === 0) {
      throw new BadRequestException('Keranjang belanja kosong!');
    }

    // 2. Hitung Total & Siapkan Data Snapshot
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
    // 3. 🎟️ LOGIC VOUCHER & DISKON
    // ==========================================
    let discountTotal = 0;
    let voucherId: bigint | null = null;
    let voucherCode: string | null = null;

    if (dto.voucherCode) {
      // A. Cari Voucher
      const voucher = await this.prisma.voucher.findUnique({
        where: { code: dto.voucherCode, isActive: true }
      });

      if (!voucher) {
        throw new BadRequestException('Voucher tidak ditemukan atau sudah tidak aktif.');
      }

      // B. Validasi Tanggal
      const now = new Date();
      if (now < voucher.startAt || now > voucher.expiresAt) {
        throw new BadRequestException('Voucher belum dimulai atau sudah kedaluwarsa.');
      }

      // C. Validasi Kuota Global
      if (voucher.usageLimitTotal !== null) {
        // Hitung berapa kali voucher ini sudah dipakai secara global
        const totalUsage = await this.prisma.voucherUsage.count({
          where: { voucherId: voucher.id }
        });
        if (totalUsage >= voucher.usageLimitTotal) {
          throw new BadRequestException('Kuota voucher ini sudah habis.');
        }
      }

      // D. Validasi Kuota Per User
      const userUsage = await this.prisma.voucherUsage.count({
        where: { voucherId: voucher.id, userId: BigInt(userId) }
      });
      if (userUsage >= voucher.usageLimitPerUser) {
        throw new BadRequestException('Anda sudah mencapai batas penggunaan voucher ini.');
      }

      // E. Validasi Minimal Belanja
      if (subtotal < Number(voucher.minPurchaseAmount)) {
        throw new BadRequestException(`Total belanja kurang. Minimal: Rp ${Number(voucher.minPurchaseAmount)}`);
      }

      // F. Kalkulasi Nominal Diskon
      if (voucher.discountType === 'fixed_amount') {
        discountTotal = Number(voucher.discountValue);
      } else if (voucher.discountType === 'percentage') {
        // Hitung persen: (Subtotal * nilai%) / 100
        discountTotal = (subtotal * Number(voucher.discountValue)) / 100;

        // Cek Max Discount (Cap)
        if (voucher.maxDiscountAmount !== null) {
          discountTotal = Math.min(discountTotal, Number(voucher.maxDiscountAmount));
        }
      }

      // Jangan sampai diskon lebih besar dari subtotal
      discountTotal = Math.min(discountTotal, subtotal);

      // Simpan data untuk dimasukkan ke DB nanti
      voucherId = voucher.id;
      voucherCode = voucher.code;

      this.logger.log(`Voucher Applied: ${voucher.code}, Discount: ${discountTotal}`);
    }
    // ==========================================
    // END LOGIC VOUCHER
    // ==========================================

    const shippingCost = dto.courier.cost;
    const taxAmount = 0;

    // Hitung Final Amount dengan Diskon
    const finalAmount = subtotal + shippingCost + taxAmount - discountTotal;
    const finalWeightGrams = Math.max(1000, totalWeight);

    const orderNumber = `ORD-${Date.now()}-${userId}`;

    try {
      return await this.prisma.$transaction(async (tx) => {

        // A. Buat Header Order
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

            courierName: dto.courier.name,
            courierService: dto.courier.service,
            shippingCost: shippingCost,
            totalWeightGrams: finalWeightGrams,

            subtotal: subtotal,
            taxAmount: taxAmount,
            discountTotal: discountTotal, // 👈 Simpan total diskon
            finalAmount: finalAmount,      // 👈 Total bayar setelah diskon
            paymentMethod: dto.paymentMethod,

            // 👈 Simpan Info Voucher
            voucherId: voucherId,
            voucherCode: voucherCode,

            orderItems: {
              create: orderItemsData
            }
          },
          include: { orderItems: true }
        });

        // B. 🎟️ CATAT PENGGUNAAN VOUCHER (PENTING!)
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

        // C. Potong Stok Varian
        for (const item of cart.cartItems) {
          await tx.productVariant.update({
            where: { id: item.productVariantId },
            data: { stockQuantity: { decrement: item.quantity } }
          });
        }

        // D. Kosongkan Keranjang
        await tx.cartItem.deleteMany({
          where: { cartId: cart.id }
        });

        // ==========================================
        // E. Generate Snap Token Midtrans (FIXED for Voucher)
        // ==========================================

        // 1. Siapkan Array Item untuk Midtrans (Format: Produk + Ongkir - Diskon)
        const midtransItems = newOrder.orderItems.map(item => ({
          id: item.productVariantId.toString(),
          price: Number(item.price),
          quantity: item.quantity,
          name: item.productName.substring(0, 50) // Midtrans batasi panjang nama
        }));

        // 2. Tambahkan Diskon sebagai "Negative Item" 
        // (Wajib ada agar gross_amount match dengan sum of items)
        if (discountTotal > 0) {
          midtransItems.push({
            id: `VOUCHER-${voucherCode || 'DISKON'}`,
            price: -Number(discountTotal), // 👈 PENTING: Harga Minus
            quantity: 1,
            name: 'Potongan Voucher'
          });
        }

        // 3. Tambahkan Ongkir sebagai Item (Agar transparan di invoice Midtrans)
        if (Number(newOrder.shippingCost) > 0) {
          midtransItems.push({
            id: 'SHIPPING-COST',
            price: Number(newOrder.shippingCost),
            quantity: 1,
            name: 'Biaya Pengiriman'
          });
        }

        const orderForMidtrans = {
          ...newOrder,
          id: newOrder.id.toString(),
          shippingCost: Number(newOrder.shippingCost),
          finalAmount: Number(newOrder.finalAmount),
          // Timpa orderItems dengan array racikan kita yang sudah ada diskon & ongkirnya
          orderItems: midtransItems
        };

        const snapToken = await this.paymentService.generateSnapToken(orderForMidtrans);

        // F. Update Order dengan Snap Token
        const finalOrder = await tx.order.update({
          where: { id: newOrder.id },
          data: { snapToken: snapToken }
        });

        this.logger.log(`Checkout Sukses dengan Voucher! Order: ${orderNumber}`);

        return {
          id: finalOrder.id.toString(),
          userId: finalOrder.userId.toString(),
          orderNumber: finalOrder.orderNumber,
          status: finalOrder.status,
          finalAmount: Number(finalOrder.finalAmount),
          snapToken: finalOrder.snapToken,
          discountTotal: Number(finalOrder.discountTotal), // Return info diskon ke frontend
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
        orderItems: true
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
        subtotal: Number(item.subtotal)
      }))
    }));
  }
}