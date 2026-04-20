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

  async checkout(userId: number, dto: CreateOrderDto & { buyNowVariantId?: string | number, buyNowQuantity?: number }) {
    this.logger.log(`Memulai proses checkout untuk User ID: ${userId}`);

    // 1. Tentukan Jalur Checkout (Buy Now atau Dari Keranjang)
    const isBuyNow = !!dto.buyNowVariantId && !!dto.buyNowQuantity;

    if ((!dto.cartItemIds || dto.cartItemIds.length === 0) && !isBuyNow) {
      throw new BadRequestException('Pilih barang dari keranjang atau gunakan fitur beli langsung.');
    }

    let itemsToCheckout: any[] = [];
    let customerEmail: string = '';
    let selectedCartItemIds: bigint[] = [];

    // ==========================================
    // 2. TARIK DATA BARANG (BUY NOW vs CART)
    // ==========================================
    if (isBuyNow) {
      // JALUR A: BELI LANGSUNG (BUY NOW)
      const variant = await this.prisma.productVariant.findUnique({
        where: { id: BigInt(dto.buyNowVariantId as string | number) },
        include: { product: true }
      });
      
      if (!variant) throw new NotFoundException('Varian produk tidak ditemukan.');
      
      const user = await this.prisma.user.findUnique({ where: { id: BigInt(userId) } });
      customerEmail = user?.email || '';

      // Format disamakan dengan struktur CartItem agar kode perhitungan di bawahnya tetap jalan
      itemsToCheckout = [{
        productVariantId: variant.id,
        quantity: dto.buyNowQuantity,
        variant: variant 
      }];

    } else {
      // JALUR B: CHECKOUT DARI KERANJANG
      selectedCartItemIds = (dto.cartItemIds || []).map(id => BigInt(id as string | number));
      const cart = await this.prisma.cart.findUnique({
        where: { userId: BigInt(userId) },
        include: {
          user: true,
          cartItems: {
            where: { id: { in: selectedCartItemIds } },
            include: { variant: { include: { product: true } } }
          }
        }
      });

      if (!cart || cart.cartItems.length === 0) {
        throw new BadRequestException('Barang yang dipilih tidak ditemukan di keranjang!');
      }
      
      customerEmail = cart.user.email;
      itemsToCheckout = cart.cartItems;
    }

    // ==========================================
    // 3. HITUNG TOTAL & CEK EVENT FLASH SALE
    // ==========================================
    let subtotal = 0;
    let totalWeight = 0;
    const orderItemsData: any = [];
    const eventUpdates: any = []; 

    // OPTIMASI N+1: Tarik semua data event terkait produk di keranjang sekaligus
    const productIdsInCart = itemsToCheckout.map(item => item.variant.productId);
    const activeEventProducts = await this.prisma.eventProduct.findMany({
      where: {
        productId: { in: productIdsInCart },
        event: {
          isActive: true,
          startAt: { lte: new Date() },
          endAt: { gte: new Date() }
        }
      }
    });

    for (const item of itemsToCheckout) {
      if (item.variant.stockQuantity < item.quantity) {
        throw new BadRequestException(`Stok Gudang ${item.variant.product.name} habis/kurang! Sisa: ${item.variant.stockQuantity}`);
      }

      // Cek ke array yang sudah difetch di luar loop (Jauh lebih cepat)
      const activeEventProduct = activeEventProducts.find(ep => ep.productId === item.variant.productId);

      let price = Number(item.variant.price);

      if (activeEventProduct && activeEventProduct.specialPrice) {
        const remainingQuota = activeEventProduct.quotaLimit - activeEventProduct.quotaSold;
        
        if (remainingQuota >= item.quantity || activeEventProduct.quotaLimit === 0) {
          price = Number(activeEventProduct.specialPrice); 
          
          eventUpdates.push({
            eventId: activeEventProduct.eventId,
            productId: activeEventProduct.productId, 
            qty: item.quantity
          });
        }
      }

      const itemSubtotal = price * item.quantity;
      subtotal += itemSubtotal;
      totalWeight += (item.variant.product.weightGrams * item.quantity);

      orderItemsData.push({
        productVariantId: item.productVariantId,
        productName: item.variant.product.name,
        variantName: item.variant.sku,
        sku: item.variant.sku,
        price: price, 
        quantity: item.quantity,
        subtotal: itemSubtotal,
      });
    }

    // ==========================================
    // 4. LOGIC VOUCHER & DISKON
    // ==========================================
    let discountTotal = 0;
    let voucherId: bigint | null = null;
    let voucherCode: string | null = null;
    let campaignId: bigint | null = null; // Tambahan untuk tracking budget

    if (dto.voucherCode) {
      const voucher = await this.prisma.voucher.findUnique({
        where: { code: dto.voucherCode, isActive: true },
        include: { campaign: true } // Jangan lupa tarik relasi campaign
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
      if (voucher.campaign.totalBudgetLimit && Number(voucher.campaign.totalBudgetLimit) > 0) {
        const remainingBudget = Number(voucher.campaign.totalBudgetLimit) - Number(voucher.campaign.totalUsedBudget);
        let estimatedDiscount = voucher.discountType === 'fixed_amount' 
          ? Number(voucher.discountValue) 
          : (subtotal * Number(voucher.discountValue)) / 100;
          
        if (voucher.maxDiscountAmount) estimatedDiscount = Math.min(estimatedDiscount, Number(voucher.maxDiscountAmount));
        estimatedDiscount = Math.min(estimatedDiscount, subtotal);

        if (remainingBudget < estimatedDiscount) {
          throw new BadRequestException('Maaf, kuota budget promo untuk voucher ini sudah habis.');
        }
      }

      discountTotal = Math.min(discountTotal, subtotal);
      voucherId = voucher.id;
      voucherCode = voucher.code;
      campaignId = voucher.campaignId; 

      this.logger.log(`Voucher Applied: ${voucher.code}, Discount: ${discountTotal}`);
    }

    const shippingCost = dto.courier.cost;
    const taxAmount = 0;
    const finalAmount = subtotal + shippingCost + taxAmount - discountTotal;
    const finalWeightGrams = Math.max(1000, totalWeight);
    const orderNumber = `SF-${Date.now()}-${userId}`;

    let finalOrderData: any = null; // Simpan data order setelah tx selesai
    try {
        
      finalOrderData = await this.prisma.$transaction(async (tx) => {
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

        // B. Catat penggunaan voucher
        if (voucherId && campaignId) {
          await tx.voucherUsage.create({
            data: {
              userId: BigInt(userId),
              voucherId: voucherId,
              orderId: newOrder.id,
              discountAmount: discountTotal
            }
          });

          await tx.campaign.update({
            where: { id: campaignId },
            data: { totalUsedBudget: { increment: discountTotal } }
          });

          await tx.userClaimedVoucher.updateMany({
            where: { 
              userId: BigInt(userId), 
              voucherId: voucherId 
            },
            data: { isUsed: true }
          });
        }

        // C. Potong Stok Gudang (Fisik) - Sekarang menggunakan itemsToCheckout
        for (const item of itemsToCheckout) {
          await tx.productVariant.update({
            where: { id: item.productVariantId },
            data: { stockQuantity: { decrement: item.quantity } }
          });
        }

        for (const eu of eventUpdates) {
          await tx.eventProduct.update({
            where: { 
              eventId_productId: { 
                eventId: eu.eventId, 
                productId: eu.productId
              } 
            },
            data: { quotaSold: { increment: eu.qty } }
          });
        }

        // E. Bersihkan Keranjang (HANYA JIKA BUKAN DARI JALUR BUY NOW)
        if (!isBuyNow && selectedCartItemIds.length > 0) {
          await tx.cartItem.deleteMany({
            where: { 
              id: { in: selectedCartItemIds }
            }
          });
        }

        return newOrder
        });

        
        const orderForMidtrans = {
        ...finalOrderData,
        id: finalOrderData.id.toString(),
        shippingCost: Number(finalOrderData.shippingCost),
        finalAmount: Number(finalOrderData.finalAmount),
        orderItems: orderItemsData
      };

      const chargeResponse = await this.chargeCoreApi(
        orderForMidtrans, 
        dto.paymentMethod as string, 
        { firstName: dto.address.recipientName, phone: dto.address.phone, email: customerEmail }
      );

      // 3. UPDATE VA/QR CODE KE DATABASE
      let paymentStatus = chargeResponse.transaction_status || 'pending';
      let vaNumber: any = null;
      let qrCodeUrl: any = null;

      if (chargeResponse.va_numbers?.length > 0) {
        vaNumber = chargeResponse.va_numbers[0].va_number;
      } else if (dto.paymentMethod === 'mandiri_va') {
        vaNumber = `${chargeResponse.biller_code}|${chargeResponse.bill_key}`;
      }

      if (chargeResponse.actions?.length > 0) {
        const qrAction = chargeResponse.actions.find((a: any) => a.name === 'generate-qr-code');
        qrCodeUrl = qrAction?.url || null;
      }

      const finalOrder = await this.prisma.order.update({
        where: { id: finalOrderData.id },
        data: { 
          vaNumber: vaNumber,      
          qrCodeUrl: qrCodeUrl,  
          status: paymentStatus === 'settlement' ? 'paid' : 'pending',
        }
      });

      this.logger.log(`Checkout Sukses! Order: ${orderNumber}`);

      return {
        id: finalOrder.id.toString(),
        orderNumber: finalOrder.orderNumber,
        status: finalOrder.status,
        finalAmount: Number(finalOrder.finalAmount),
        paymentMethod: dto.paymentMethod,
        vaNumber: vaNumber,
        qrCodeUrl: qrCodeUrl,
        expireTime: chargeResponse.expiry_time 
      };

    } catch (error: any) {
      this.logger.error(`Gagal melakukan checkout: ${error.message}`);
      throw new InternalServerErrorException(error.message || 'Terjadi kesalahan saat memproses pesanan.');
    }
  }

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

    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where: whereClause }),
      this.prisma.order.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          user: { select: { name: true, email: true, phone: true } },
          orderItems: { include: { productVariant: { include: { product: true } } } } 
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
        orderItems: { include: { productVariant: { include: { product: true } } } },
        voucherUsages: true
      }
    });

    if (!order) throw new NotFoundException('Order tidak ditemukan');

    return this.formatOrderForResponse(order);
  }

  async updateOrderStatus(id: string, status: string, trackingNumber?: string) {
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

  // Batal Order (Admin)
  private async cancelOrderAdmin(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: BigInt(id) },
      include: { orderItems: true }
    });

    if (!order) throw new NotFoundException('Order tidak ditemukan');

    if (order.status === ('shipped' as OrderStatus) || order.status === ('delivered' as OrderStatus)) {
      throw new BadRequestException('Order yang sudah dikirim atau selesai tidak dapat dibatalkan.');
    }
    if (order.status === ('cancelled' as OrderStatus)) {
      throw new BadRequestException('Order ini sudah dibatalkan sebelumnya.');
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

        for (const item of updated.orderItems) { 
          
          await tx.productVariant.update({
            where: { id: item.productVariantId },
            data: { stockQuantity: { increment: item.quantity } }
          });

          const eventItem = await tx.eventProduct.findFirst({
            where: { productId: item.productVariant.productId } 
          });

          if (eventItem) {
            await tx.eventProduct.update({
              where: {
                eventId_productId: {
                  eventId: eventItem.eventId,
                  productId: item.productVariant.productId 
                }
              },
              data: { quotaSold: { decrement: item.quantity } }
            });
          }
        }

        if (order.voucherId) {
          await tx.voucherUsage.deleteMany({
            where: { orderId: order.id } 
          });

          await tx.userClaimedVoucher.updateMany({
            where: {
              userId: BigInt(order.userId),
              voucherId: order.voucherId
            },
            data: { isUsed: false }
          });

          const voucher = await tx.voucher.findUnique({
            where: { id: order.voucherId }
          });

          if (voucher && voucher.campaignId) {
            await tx.campaign.update({
              where: { id: voucher.campaignId },
              data: { totalUsedBudget: { decrement: order.discountTotal } }
            });
          }
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

        for (const item of updated.orderItems) { 
          
          await tx.productVariant.update({
            where: { id: item.productVariantId },
            data: { stockQuantity: { increment: item.quantity } }
          });

          const eventItem = await tx.eventProduct.findFirst({
            where: { productId: item.productVariant.productId }  
          });

          if (eventItem) {
            await tx.eventProduct.update({
              where: {
                eventId_productId: { 
                  eventId: eventItem.eventId,
                  productId: item.productVariant.productId 
                }
              },
              data: { quotaSold: { decrement: item.quantity } }
            });
          }
        }

        if (order.voucherId) {
          await tx.voucherUsage.deleteMany({
            where: { orderId: order.id } 
          });

          await tx.userClaimedVoucher.updateMany({
            where: {
              userId: BigInt(order.userId),
              voucherId: order.voucherId
            },
            data: { isUsed: false }
          });

          const voucher = await tx.voucher.findUnique({
            where: { id: order.voucherId }
          });

          if (voucher && voucher.campaignId) {
            await tx.campaign.update({
              where: { id: voucher.campaignId },
              data: { totalUsedBudget: { decrement: order.discountTotal } }
            });
          }
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

  // ==========================================
  // INTEGRASI KOMERCE
  // ==========================================
  async processKomerceShipment(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: BigInt(orderId) },
    });

    if (!order) throw new NotFoundException('Order tidak ditemukan');
    
    if (!order.komerceOrderId) {
      throw new BadRequestException('Order ini belum terdaftar di Komerce. Pastikan webhook Midtrans berhasil.');
    }

    // 1. Deteksi apakah ini kurir Instant
    const courierName = order.courierName?.toUpperCase() || '';
    const isInstantCourier = courierName.includes('GOSEND') || courierName.includes('GRAB');

    try {
      if (isInstantCourier) {
        this.logger.log(`Bypass Komerce Pickup API untuk kurir Instant (${courierName}). Komerce ID: ${order.komerceOrderId}`);
        // Catatan: Kurir Instant tidak perlu dijadwalkan via endpoint pickup/request.
        // Asumsinya Komerce langsung mencari driver saat Store Order (Webhook), 
        // jadi Admin hanya menekan tombol untuk mengubah status ke Shipped.
      } else {
        // 2. Logic Ekspedisi Reguler (JNT, Sicepat, JNE, dll)
        const komerceBaseUrl = process.env.KOMERCE_BASE_URL;
        const apiKey = process.env.KOMERCE_API_KEY;

        if (!apiKey || !komerceBaseUrl) {
          throw new InternalServerErrorException('Konfigurasi Komerce di .env belum lengkap.');
        }

        this.logger.log(`Request Kurir Pickup Reguler untuk Komerce ID: ${order.komerceOrderId}`);
        
        const pickupDateObj = new Date();
        pickupDateObj.setHours(pickupDateObj.getHours() + 2);

        // Paksa format output menjadi waktu WIB (Asia/Jakarta) agar server UTC Docker tidak ngaco
        const pickupDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(pickupDateObj); // Hasil: YYYY-MM-DD
        const pickupTimeStr = new Intl.DateTimeFormat('en-GB', { 
          timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit' 
        }).format(pickupDateObj); // Hasil: HH:mm:ss

        const pickupPayload = {
          pickup_date: pickupDateStr,
          pickup_time: pickupTimeStr,
          pickup_vehicle: order.totalWeightGrams > 5000 ? 'Mobil' : 'Motor', 
          orders: [
            { order_no: order.komerceOrderId } // Sekarang ini berisi string "KOM..."
          ]
        };

        const pickupResponse = await fetch(`${komerceBaseUrl}/order/api/v1/pickup/request`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'x-api-key': apiKey
          },
          body: JSON.stringify(pickupPayload)
        });

        const pickupData = await pickupResponse.json();

        if (![200, 201].includes(pickupData.meta?.code)) {
          this.logger.error(`Komerce Pickup Error: ${JSON.stringify(pickupData)}`);
          throw new Error(pickupData.meta?.message || 'Gagal menjadwalkan pickup di Komerce');
        }

        const pickupResult = pickupData.data?.[0];
        if (pickupResult?.status === 'failed') {
          this.logger.warn(`Pickup Komerce Ditolak untuk Order ID: ${order.komerceOrderId}. Respon: ${JSON.stringify(pickupResult)}`);
          throw new Error(`Komerce menolak request pickup. (Kurir: ${courierName})`);
        }
      }

      // 3. Update status pesanan menjadi 'shipped'
      const updatedOrder = await this.prisma.order.update({
        where: { id: BigInt(orderId) },
        data: { status: 'shipped' }
      });

      return {
        message: isInstantCourier ? 'Kurir Instant diproses' : 'Berhasil request kurir Komerce',
        resi: updatedOrder.trackingNumber,
        order: this.formatOrderForResponse(updatedOrder)
      };

    } catch (error: any) {
      this.logger.error(`Gagal integrasi Komerce Pickup: ${error.message}`);
      throw new InternalServerErrorException(error.message || 'Gagal memanggil kurir');
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
}