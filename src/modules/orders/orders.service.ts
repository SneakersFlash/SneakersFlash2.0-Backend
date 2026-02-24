import { BadRequestException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentService } from '../payment/payment.service';
import { CreateOrderDto } from './dto/create-order.dto';

@Injectable()
export class OrdersService {
  // Tambahkan Logger untuk tracking aktivitas transaksi
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private prisma: PrismaService,
    private paymentService: PaymentService // ✅ INJECT PAYMENT SERVICE DI SINI
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
    let totalWeight = 0; // 👈 TAMBAHAN 1: Siapkan variabel penampung berat
    const orderItemsData: any = [];

    for (const item of cart.cartItems) {
      // Cek Stok Real-time sebelum masuk transaksi database
      if (item.variant.stockQuantity < item.quantity) {
        throw new BadRequestException(`Stok ${item.variant.product.name} habis/kurang! Sisa: ${item.variant.stockQuantity}`);
      }

      const price = Number(item.variant.price);
      const itemSubtotal = price * item.quantity;
      subtotal += itemSubtotal;

      // 👈 TAMBAHAN 2: Hitung berat (Berat per item x Jumlah beli)
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

    const shippingCost = dto.courier.cost;
    const taxAmount = 0;
    const discountTotal = 0;
    const finalAmount = subtotal + shippingCost + taxAmount - discountTotal;

    // 👈 TAMBAHAN 3: Pastikan berat minimal 1000 gram (1 Kg) untuk ekspedisi
    const finalWeightGrams = Math.max(1000, totalWeight);

    const orderNumber = `ORD-${Date.now()}-${userId}`;

    try {
      // 3. TRANSACTION: Eksekusi Database secara Atomic
      return await this.prisma.$transaction(async (tx) => {

        // A. Buat Header Order beserta Items-nya
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

            totalWeightGrams: finalWeightGrams, // 👈 TAMBAHAN 4: Simpan berat ke tabel Order

            subtotal: subtotal,
            taxAmount: taxAmount,
            discountTotal: discountTotal,
            finalAmount: finalAmount,
            paymentMethod: dto.paymentMethod,

            orderItems: {
              create: orderItemsData
            }
          },
          include: { orderItems: true } // Return sekalian items-nya untuk payload Midtrans
        });

        // B. Potong Stok Varian secara aman
        for (const item of cart.cartItems) {
          await tx.productVariant.update({
            where: { id: item.productVariantId },
            data: { stockQuantity: { decrement: item.quantity } }
          });
        }

        // C. Kosongkan Keranjang Belanja User
        await tx.cartItem.deleteMany({
          where: { cartId: cart.id }
        });

        // D. Generate Snap Token Midtrans
        const orderForMidtrans = {
          ...newOrder,
          id: newOrder.id.toString(),
          shippingCost: Number(newOrder.shippingCost),
          finalAmount: Number(newOrder.finalAmount),
          orderItems: newOrder.orderItems.map(item => ({
            productVariantId: item.productVariantId.toString(),
            price: Number(item.price),
            quantity: item.quantity,
            productName: item.productName
          }))
        };

        const snapToken = await this.paymentService.generateSnapToken(orderForMidtrans);

        // E. Update Order dengan Snap Token
        const finalOrder = await tx.order.update({
          where: { id: newOrder.id },
          data: { snapToken: snapToken }
        });

        this.logger.log(`Checkout Sukses! Order Number: ${orderNumber}`);

        // F. Return Data dengan Safe-Serialization (Ubah BigInt ke String)
        return {
          id: finalOrder.id.toString(),
          userId: finalOrder.userId.toString(),
          orderNumber: finalOrder.orderNumber,
          status: finalOrder.status,
          finalAmount: Number(finalOrder.finalAmount),
          snapToken: finalOrder.snapToken,
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

    // Serialisasi BigInt yang sangat aman agar Frontend tidak crash
    return orders.map(o => ({
      ...o,
      id: o.id.toString(),
      userId: o.userId.toString(),
      subtotal: Number(o.subtotal),
      shippingCost: Number(o.shippingCost),
      finalAmount: Number(o.finalAmount),
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