import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentService } from '../payment/payment.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderStatus, Prisma } from '@prisma/client';
import { UsersService } from '../users/users.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private prisma: PrismaService,
    private paymentService: PaymentService,
    private usersService: UsersService,
    private notificationsService: NotificationsService 
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
        include: { 
          product: true,
          variantOptions: {
            include: {
              optionValue: {
                include: { option: true }
              }
            }
          }  
        }
      });
      
      if (!variant) throw new NotFoundException('Varian produk tidak ditemukan.');
      
      const user = await this.prisma.user.findUnique({ where: { id: BigInt(userId) } });
      if (!user) throw new NotFoundException('User tidak ditemukan.');
      customerEmail = user.email;

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
            include: { variant: { include: { 
                product: true,
                variantOptions: {
                  include: {
                    optionValue: {
                      include: { option: true }
                    }
                  }
                }
              }
            } 
          }
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

      const variantPrice = Number(item.variant.price);
      let price = variantPrice;

      if (activeEventProduct && activeEventProduct.specialPrice) {
        const eventPrice     = Number(activeEventProduct.specialPrice);
        const remainingQuota = activeEventProduct.quotaLimit - activeEventProduct.quotaSold;
        const isQuotaOk      = activeEventProduct.quotaLimit === 0 || remainingQuota >= item.quantity;

        // Guard: event price hanya berlaku jika LEBIH MURAH dari harga varian.
        // Mencegah varian murah (mis. size 40) malah jadi lebih mahal saat event.
        if (eventPrice < variantPrice && isQuotaOk) {
          price = eventPrice;

          eventUpdates.push({
            eventId:   activeEventProduct.eventId,
            productId: activeEventProduct.productId,
            qty:       item.quantity
          });
        }
      }

      const itemSubtotal = price * item.quantity;
      subtotal += itemSubtotal;
      totalWeight += (item.variant.product.weightGrams * item.quantity);

      const sizeOption = item.variant.variantOptions?.find(
        (vo: any) =>
          vo.optionValue.option.name.toLowerCase() === 'ukuran' ||
          vo.optionValue.option.name.toLowerCase() === 'size'
      );
      const size = sizeOption?.optionValue.value ?? '';

      orderItemsData.push({
        productVariantId: item.productVariantId,
        // "Nama Produk SKUPARENT-001 VAR-SKU-001 42"
        productName: [
          item.variant.product.name,
          item.variant.sku,
          size,
        ].filter(Boolean).join(' '),
        variantName: [item.variant.sku, size].filter(Boolean).join(' '),
        sku: item.variant.product.skuParent ?? item.variant.sku,
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
        include: {
          campaign: true,
          _count: { select: { usages: true } } // H-03: gunakan nama relasi yang benar
        }
      });

      if (!voucher) throw new BadRequestException('Voucher tidak ditemukan atau sudah tidak aktif.');

      const now = new Date();
      if (now < voucher.startAt || now > voucher.expiresAt) {
        throw new BadRequestException('Voucher belum dimulai atau sudah kedaluwarsa.');
      }

      // H-04: Validasi kepemilikan voucher private
      if (voucher.userId !== null && voucher.userId !== BigInt(userId)) {
        throw new BadRequestException('Voucher ini bersifat private dan tidak dapat digunakan oleh akun Anda.');
      }

      // H-03: Gunakan _count.usages (nama relasi yang benar di schema)
      if (voucher.usageLimitTotal !== null) {
        if (voucher._count.usages >= voucher.usageLimitTotal) {
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

    try {
      // ==========================================
      // 5. CHARGE MIDTRANS TERLEBIH DAHULU
      // Order TIDAK dibuat jika Midtrans gagal
      // ==========================================
      const orderForMidtrans = {
        orderNumber: orderNumber,
        shippingCost: shippingCost,
        finalAmount: finalAmount,
        discountTotal: discountTotal,
        orderItems: orderItemsData,
      };

      const chargeResponse = await this.chargeCoreApi(
        orderForMidtrans,
        dto.paymentMethod as string,
        { firstName: dto.address.recipientName, phone: dto.address.phone, email: customerEmail }
      );

      // ─── Ekstrak VA Number (Bank Transfer) ───────────────────────────────
      let paymentStatus = chargeResponse.transaction_status || 'pending';
      let vaNumber: any = null;
      let qrCodeUrl: any = null;

      if (chargeResponse.va_numbers?.length > 0) {
        vaNumber = chargeResponse.va_numbers[0].va_number;
      } else if (dto.paymentMethod === 'mandiri_va') {
        vaNumber = `${chargeResponse.biller_code}|${chargeResponse.bill_key}`;
      }

      // ─── Ekstrak QR Code URL (QRIS, GoPay, ShopeePay) ────────────────────
      if (chargeResponse.actions?.length > 0) {
        const qrAction = chargeResponse.actions.find((a: any) => a.name === 'generate-qr-code');
        qrCodeUrl = qrAction?.url || null;
      }

      // ==========================================
      // 6. MIDTRANS BERHASIL → SIMPAN ORDER KE DB
      // ==========================================
      const finalOrder = await this.prisma.$transaction(async (tx) => {
        // A. Buat Header Order
        const newOrder = await tx.order.create({
          data: {
            userId: BigInt(userId),
            orderNumber: orderNumber,
            status: paymentStatus === 'settlement' ? 'paid' : 'pending',

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

            vaNumber: vaNumber,
            qrCodeUrl: qrCodeUrl,

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

        // C. Potong Stok Gudang (Fisik) - H-01: Atomic UPDATE dengan WHERE guard
        // Mencegah race condition oversell: hanya kurangi stok jika stok masih mencukupi
        for (const item of itemsToCheckout) {
          const affected = await tx.$executeRaw`
            UPDATE product_variants
            SET stock_quantity = stock_quantity - ${item.quantity}
            WHERE id = ${item.productVariantId}::bigint
              AND stock_quantity >= ${item.quantity}
          `;
          if (affected === 0) {
            throw new BadRequestException(
              `Stok ${item.variant.product.name} habis atau tidak mencukupi saat diproses. Silakan periksa kembali keranjang Anda.`
            );
          }
        }

        // D. Update Kuota Flash Sale - H-02: Atomic UPDATE dengan WHERE guard
        // Mencegah race condition quota terlampaui: hanya tambah jika kuota masih tersedia
        for (const eu of eventUpdates) {
          // FOR UPDATE: kunci row event_products di dalam transaksi.
          // Request concurrent lain yang menyentuh event + product yang sama
          // akan menunggu sampai transaksi ini selesai — tidak bisa lolos
          // ke Midtrans bersamaan dengan data quota yang stale.
          const lockedRows = await tx.$queryRaw<{ quota_limit: number; quota_sold: number }[]>`
            SELECT quota_limit, quota_sold
            FROM event_products
            WHERE event_id  = ${eu.eventId}::bigint
              AND product_id = ${eu.productId}::bigint
            FOR UPDATE
          `;

          const locked = lockedRows[0];
          if (locked && locked.quota_limit > 0 && locked.quota_sold + eu.qty > locked.quota_limit) {
            throw new BadRequestException(
              `Kuota flash sale untuk produk ini telah habis. Silakan lanjutkan dengan harga normal.`
            );
          }

          // Atomic UPDATE — data sudah terkunci di atas, ini pasti fresh
          const affected = await tx.$executeRaw`
            UPDATE event_products
            SET quota_sold = quota_sold + ${eu.qty}
            WHERE event_id  = ${eu.eventId}::bigint
              AND product_id = ${eu.productId}::bigint
              AND (quota_limit = 0 OR quota_sold + ${eu.qty} <= quota_limit)
          `;
          if (affected === 0) {
            throw new BadRequestException(
              `Kuota flash sale untuk produk ini telah habis. Silakan lanjutkan dengan harga normal.`
            );
          }
        }

        // E. Bersihkan Keranjang (HANYA JIKA BUKAN DARI JALUR BUY NOW)
        if (!isBuyNow && selectedCartItemIds.length > 0) {
          await tx.cartItem.deleteMany({
            where: {
              id: { in: selectedCartItemIds }
            }
          });
        }

        return newOrder;
      });

      this.logger.log(`Checkout Sukses! Order: ${orderNumber}`);

      const baseWebUrl = process.env.FRONTEND_URL || 'https://sneakersflash.com';
        const paymentLink = `${baseWebUrl}/orders/${finalOrder.id}`; // Ganti path sesuai routing frontend Anda
        
        this.notificationsService.sendPaymentInstructionEmail(
            customerEmail,
            orderNumber,
            finalAmount,
            vaNumber,
            qrCodeUrl,
            paymentLink
        ).catch(err => this.logger.error(`Gagal kirim email pembayaran ke ${customerEmail}`, err));

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
      throw error instanceof BadRequestException || error instanceof NotFoundException
        ? error
        : new InternalServerErrorException(error.message || 'Terjadi kesalahan saat memproses pesanan.');
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
 
    const [total, orders, statusCounts] = await Promise.all([
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
      }),
      // Query ketiga: hitung semua status sekaligus tanpa filter apapun
      // sehingga stat cards di FE tidak perlu hit endpoint terpisah
      this.prisma.order.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);
 
    // Konversi array groupBy ke object { pending: 12, paid: 5, ... }
    const countByStatus = statusCounts.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});
 
    const summary = {
      total_all:       Object.values(countByStatus).reduce((a, b) => a + b, 0),
      pending:         countByStatus['pending']         ?? 0,
      waiting_payment: countByStatus['waiting_payment'] ?? 0,
      paid:            countByStatus['paid']            ?? 0,
      processing:      countByStatus['processing']      ?? 0,
      shipped:         countByStatus['shipped']         ?? 0,
      delivered:       countByStatus['delivered']       ?? 0,
      completed:       countByStatus['completed']       ?? 0,
      cancelled:       countByStatus['cancelled']       ?? 0,
      returned:        countByStatus['returned']        ?? 0,
    };
 
    const lastPage = Math.ceil(total / limit);
 
    return {
      data: orders.map(o => this.formatOrderForResponse(o)),
      meta: {
        total,       // total sesuai filter aktif (untuk pagination)
        page,
        limit,
        lastPage,
        hasNextPage: page < lastPage,
        hasPrevPage: page > 1,
        summary,     // ringkasan per-status, selalu dihitung dari semua data
      }
    };
  }


  async findOne(id: string, userId: string | number, role: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: BigInt(id) },
      include: {
        user: { select: { name: true, email: true, phone: true } },
        orderItems: { include: { productVariant: { include: { product: true } } } },
        voucherUsages: true
      }
    });

    if (!order) throw new NotFoundException('Order tidak ditemukan');

    // 🔒 Validasi Keamanan: Mencegah IDOR
    if (role !== 'admin' && order.userId !== BigInt(userId)) {
      this.logger.warn(`Upaya akses ilegal! User ${userId} mencoba mengakses order ${id}`);
      throw new ForbiddenException('Akses ditolak. Anda tidak berhak melihat detail pesanan ini.');
    }

    return this.formatOrderForResponse(order);
  }

  async updateOrderStatus(id: string, status: string, trackingNumber?: string) {
    if (status === 'CANCELLED') {
      return this.cancelOrderAdmin(id);
    }

    try {
      // 1. Tarik order yang ada sebelum di-update untuk pengecekan Tier user saat ini
      const existingOrder = await this.prisma.order.findUnique({
        where: { id: BigInt(id) },
        include: { user: true }
      });

      if (!existingOrder) throw new NotFoundException('Order tidak ditemukan');

      // 2. Bungkus proses ke dalam transaksi
      const updatedOrder = await this.prisma.$transaction(async (tx) => {
        const order = await tx.order.update({
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

        // 3. LOGIKA TAMBAH POIN: Hanya berjalan jika status menjadi 'completed'
        if (status === 'completed' && existingOrder.status !== 'completed') {
          let pointPercentage = 0.01; // Basic (1%)
          
          if (existingOrder.user.customerTier === 'advance') {
              pointPercentage = 0.025; // Advance (2.5%)
          } else if (existingOrder.user.customerTier === 'ultimate') {
              pointPercentage = 0.05; // Ultimate (5%)
          }

          // Hitung Poin (finalAmount * persentase)
          const earnedPoints = Number(order.finalAmount) * pointPercentage;

          // Tambahkan poin ke saldo user
          await tx.user.update({
            where: { id: order.userId },
            data: { pointsBalance: { increment: earnedPoints } }
          });
        }

        return order;
      });

      // 4. TRIGGER EVALUASI TIER
      // Setelah transaksi poin sukses dan pesanan selesai, cek apakah user naik/turun level
      if (status === 'completed' && existingOrder.status !== 'completed') {
        // Panggil fungsi evaluate yang sudah kamu buat di users.service.ts secara background
        this.usersService.evaluateCustomerTier(existingOrder.userId).catch(err => {
          this.logger.error(`Gagal mengevaluasi tier untuk user ${existingOrder.userId}:`, err);
        });
      }

      this.logger.log(`Status order ${id} diubah menjadi ${status}`);
      return this.formatOrderForResponse(updatedOrder);
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException('Gagal update status order');
    }
  }

  // Batal Order (Admin)
  // ─── AUTO-CANCEL: Order pending > 1 jam otomatis dibatalkan ─────────────────
  // Cron berjalan setiap 5 menit. Mencari semua order berstatus 'pending'
  // yang dibuat lebih dari 1 jam lalu, lalu membatalkannya beserta:
  //   - Restore stok produk
  //   - Rollback kuota flash sale
  //   - Rollback voucher (hapus usage, mark isUsed=false, rollback campaign budget)
  @Cron(CronExpression.EVERY_5_MINUTES)
  async cancelExpiredOrders() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
 
    // ✅ FIX #2: Tambah 'waiting_payment' agar order yang sudah di-charge Midtrans
    // tapi belum dibayar juga ikut ter-cancel
    const expiredOrders = await this.prisma.order.findMany({
      where: {
        status: { in: ['pending', 'waiting_payment'] as OrderStatus[] },
        createdAt: { lt: oneHourAgo },
      },
      select: { id: true, orderNumber: true, paymentMethod: true, vaNumber: true },
    });
 
    if (expiredOrders.length === 0) return;
 
    this.logger.log(`[AutoCancel] Ditemukan ${expiredOrders.length} order expired, memulai pembatalan...`);
 
    for (const order of expiredOrders) {
      try {
        // ✅ FIX #3: Cancel transaksi di Midtrans sebelum update DB
        // Agar VA number / QR Code tidak bisa dipakai lagi oleh user
        try {
          await this.cancelMidtransTransaction(order.orderNumber);
        } catch (midtransErr: any) {
          // Jangan hard-fail — log saja. Midtrans mungkin sudah expire sendiri.
          this.logger.warn(`[AutoCancel] Midtrans cancel gagal untuk ${order.orderNumber}: ${midtransErr.message}`);
        }
 
        await this.cancelOrderAdmin(order.id.toString());
        this.logger.log(`[AutoCancel] Order ${order.orderNumber} berhasil dibatalkan.`);
      } catch (error: any) {
        // Log error per order tapi lanjut ke order berikutnya
        this.logger.error(`[AutoCancel] Gagal batalkan order ${order.orderNumber}: ${error.message}`);
      }
    }
 
    this.logger.log(`[AutoCancel] Selesai memproses ${expiredOrders.length} order expired.`);
  }
 
  // ─── Helper: Cancel transaksi ke Midtrans ────────────────────────────────────
  // Dipanggil sebelum auto-cancel DB agar VA/QR tidak bisa dibayar lagi.
  // Endpoint: POST /v2/{order_id}/cancel
  private async cancelMidtransTransaction(orderNumber: string): Promise<void> {
    const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';
    const baseUrl = isProduction
      ? `https://api.midtrans.com/v2/${orderNumber}/cancel`
      : `https://api.sandbox.midtrans.com/v2/${orderNumber}/cancel`;
 
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const authString = Buffer.from(`${serverKey}:`).toString('base64');
 
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Basic ${authString}`,
      },
    });
 
    const data = await response.json();
 
    // Status 200 atau 412 (sudah expire) = aman dilanjutkan
    const okCodes = ['200', '412'];
    if (!okCodes.includes(data.status_code)) {
      throw new Error(`Midtrans cancel failed: ${data.status_message}`);
    }
 
    this.logger.log(`[Midtrans] Transaksi ${orderNumber} berhasil dibatalkan di Midtrans.`);
  }

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

          // Restore stok — pakai productVariantId langsung dari OrderItem (aman, tidak butuh relasi)
          await tx.productVariant.update({
            where: { id: item.productVariantId },
            data: { stockQuantity: { increment: item.quantity } }
          });

          // ✅ FIX #1: Guard null sebelum akses item.productVariant
          // Jika variant dihapus setelah order dibuat, relasi bisa null.
          // Tanpa guard ini, cancelOrderAdmin crash dengan TypeError dan
          // seluruh transaksi rollback — order tidak ter-cancel sama sekali.
          if (item.productVariant) {
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
          } else {
            // Log agar mudah di-trace jika ada variant yang hilang
            this.logger.warn(
              `[cancelOrderAdmin] productVariant null untuk orderItem ${item.id} (variantId: ${item.productVariantId}). Skip rollback flash sale quota.`
            );
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

        // 1. Validasi Response Komerce
        if (![200, 201].includes(pickupData.meta?.code)) {
          this.logger.error(`Komerce Pickup Error: ${JSON.stringify(pickupData)}`);
          throw new Error(pickupData.meta?.message || 'Gagal menjadwalkan pickup di Komerce');
        }

        const pickupResult = pickupData.data?.[0];
        if (pickupResult?.status === 'failed') {
          this.logger.warn(`Pickup Komerce Ditolak untuk Order ID: ${order.komerceOrderId}. Respon: ${JSON.stringify(pickupResult)}`);
          throw new Error(`Komerce menolak request pickup. (Kurir: ${courierName})`);
        }

        // ==============================================================
        // PERBAIKAN: TANGKAP AWB DARI RESPONSE KOMERCE
        // ==============================================================
        const komerceAwb = pickupResult?.awb; // Menangkap field "awb" dari response Komerce
        
        // 2. Update status pesanan dan simpan awbTrackingNumber
        const updatedOrder = await this.prisma.order.update({
          where: { id: BigInt(orderId) },
          data: { 
            status: 'shipped',
            awbTrackingNumber: komerceAwb || undefined // 👈 Simpan AWB ke field baru
          }
        });

        return {
          message: 'Berhasil request kurir Komerce',
          // Kembalikan AWB jika ada, kalau tidak fallback ke trackingNumber manual
          resi: updatedOrder.awbTrackingNumber || updatedOrder.trackingNumber, 
          order: this.formatOrderForResponse(updatedOrder)
        };

      }

    } catch (error: any) {
      this.logger.error(`Gagal integrasi Komerce Pickup: ${error.message}`);
      throw new InternalServerErrorException(error.message || 'Gagal memanggil kurir');
    }
  }
  // ==========================================
  // UTILS
  // ==========================================
  
  // Helper untuk membersihkan BigInt agar aman saat di-return sebagai JSON
  // ==========================================
  // EXPORT ORDERS TO CSV
  // ==========================================
  async exportOrders(params: {
    status?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<{ csv: string; filename: string }> {
    const { status, search, dateFrom, dateTo } = params;

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

    if (dateFrom || dateTo) {
      whereClause.createdAt = {
        ...(dateFrom && { gte: new Date(dateFrom) }),
        ...(dateTo && { lte: new Date(new Date(dateTo).setHours(23, 59, 59, 999)) }),
      };
    }

    const orders = await this.prisma.order.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { name: true, email: true, phone: true },
        },
        // Relasi voucher → campaign (data marketing utama)
        voucher: {
          include: { campaign: true },
        },
        // Tiap item → varian → produk → event products → event
        // Dipakai untuk mendeteksi apakah item dibeli saat flash sale
        orderItems: {
          include: {
            productVariant: {
              include: {
                product: {
                  include: {
                    eventProducts: {
                      include: { event: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    // ── Helper: format tanggal ke WIB (UTC+7) ──
    const fmtDate = (d: Date | null | undefined): string => {
      if (!d) return '-';
      return new Date(d.getTime() + 7 * 60 * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .substring(0, 19);
    };

    // ── Helper: escape cell CSV (handle koma & newline) ──
    const esc = (val: any): string => {
      const str = val === null || val === undefined ? '' : String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    };

    const headers = [
      'No. Order',
      'Tanggal Order (WIB)',
      'Tanggal Bayar (WIB)',
      'Status',
      // Customer
      'Nama Customer',
      'Email Customer',
      'No. HP Customer',
      // Item
      'Nama Produk',
      'SKU Varian',
      'Qty',
      'Harga Satuan (Rp)',
      'Subtotal Item (Rp)',
      // Marketing — Event / Flash Sale
      'Event Flash Sale',
      'Harga Event (Rp)',
      'Sisa Quota Event',
      // Marketing — Voucher & Campaign
      'Kode Voucher',
      'Nama Voucher',
      'Campaign',
      'Tipe Diskon Voucher',
      'Nilai Diskon Voucher',
      'Diskon Applied (Rp)',
      // Financial
      'Subtotal Order (Rp)',
      'Ongkir (Rp)',
      'Total Akhir (Rp)',
      'Metode Bayar',
      // Pengiriman
      'Nama Penerima',
      'Kota',
      'Provinsi',
      'Kurir',
      'Servis Kurir',
      'Komerce ID',
      'No Resi'
    ];

    const rows: string[] = [headers.join(',')];

    for (const order of orders) {
      const voucher     = (order as any).voucher ?? null;
      const campaign    = voucher?.campaign ?? null;
      const orderItems  = (order as any).orderItems ?? [];

      // Jika tidak ada item (edge case), tetap ekspor 1 baris ringkasan order
      const itemsToExport = orderItems.length > 0 ? orderItems : [null];

      for (const item of itemsToExport) {
        // ── Data item ──
        let productName  = '-';
        let variantSku   = '-';
        let qty          = '-';
        let unitPrice: any    = '-';
        let itemSubtotal: any = '-';

        // ── Marketing: Event / Flash Sale ──
        let eventName         = '-';
        let eventSpecialPrice: any = '-';
        let eventQuotaLeft : any   = '-';

        if (item) {
          productName  = item.productName ?? '-';
          variantSku   = item.variantName ?? item.sku ?? '-';
          qty          = item.quantity;
          unitPrice    = Number(item.price);
          itemSubtotal = Number(item.subtotal);

          // Cocokkan event: produk yang sama, event aktif saat order dibuat,
          // dan harga item === specialPrice event (bukti item dibeli saat flash sale)
          const product       = item.productVariant?.product;
          const eventProducts = product?.eventProducts ?? [];
          const orderCreated  = order.createdAt;

          const matchedEventProduct = eventProducts.find((ep: any) => {
            const ev         = ep.event;
            const isInPeriod = ev && ev.startAt <= orderCreated && ev.endAt >= orderCreated;
            const priceMatch = ep.specialPrice && Number(ep.specialPrice) === Number(item.price);
            return isInPeriod && priceMatch;
          });

          if (matchedEventProduct) {
            eventName         = matchedEventProduct.event.title;
            eventSpecialPrice = Number(matchedEventProduct.specialPrice);
            eventQuotaLeft    =
              matchedEventProduct.quotaLimit > 0
                ? matchedEventProduct.quotaLimit - matchedEventProduct.quotaSold
                : 'Unlimited';
          }
        }

        // ── Marketing: Voucher ──
        const voucherCode      = order.voucherCode ?? '-';
        const voucherName      = voucher?.name ?? '-';
        const campaignName     = campaign?.name ?? '-';
        const discountType     = voucher?.discountType ?? '-';
        const discountValue    = voucher
          ? (voucher.discountType === 'percentage'
              ? `${Number(voucher.discountValue)}%`
              : `Rp ${Number(voucher.discountValue).toLocaleString('id-ID')}`)
          : '-';
        const discountApplied  = Number(order.discountTotal ?? 0);

        const row = [
          esc(order.orderNumber),
          esc(fmtDate(order.createdAt)),
          esc(fmtDate((order as any).paidAt)),
          esc(order.status),
          // Customer
          esc((order as any).user?.name ?? '-'),
          esc((order as any).user?.email ?? '-'),
          esc((order as any).user?.phone ?? '-'),
          // Item
          esc(productName),
          esc(variantSku),
          esc(qty),
          esc(unitPrice),
          esc(itemSubtotal),
          // Event
          esc(eventName),
          esc(eventSpecialPrice),
          esc(eventQuotaLeft),
          // Voucher & Campaign
          esc(voucherCode),
          esc(voucherName),
          esc(campaignName),
          esc(discountType),
          esc(discountValue),
          esc(discountApplied),
          // Financial
          esc(Number(order.subtotal)),
          esc(Number(order.shippingCost)),
          esc(Number(order.finalAmount)),
          esc(order.paymentMethod ?? '-'),
          // Pengiriman
          esc(order.shippingRecipientName),
          esc(order.shippingCity),
          esc((order as any).shippingProvince ?? '-'),
          esc(order.courierName),
          esc(order.courierService),
          esc(order.trackingNumber),
          esc(order.awbTrackingNumber),
        ];

        rows.push(row.join(','));
      }
    }

    // BOM UTF-8 agar Excel bisa buka langsung tanpa garbled text
    const csv = '\uFEFF' + rows.join('\n');

    const now      = new Date();
    const dateStr  = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const filename = `orders-export-${dateStr}.csv`;

    return { csv, filename };
  }

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
      komerceOrderId: order.komerceOrderId,
      awb: order.awbTrackingNumber,
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
    const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';
    const coreApiUrl = isProduction
      ? 'https://api.midtrans.com/v2/charge'
      : 'https://api.sandbox.midtrans.com/v2/charge';

    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const authString = Buffer.from(`${serverKey}:`).toString('base64');

    // ─── Guard: email wajib ada ──────────────────────────────────────────────
    // Midtrans otomatis kirim email instruksi pembayaran ke customer.
    // Aktifkan di: Midtrans Dashboard → Settings → Email Notifications.
    const customerEmail = customerDetails.email?.trim();
    if (!customerEmail) {
      throw new BadRequestException(
        'Email customer tidak ditemukan. Tidak dapat memproses pembayaran.',
      );
    }

    // ─── Base callback URL ────────────────────────────────────────────────────
    // Tambahkan MIDTRANS_CALLBACK_BASE_URL di .env, contoh: https://sneakersflash.com
    const baseCallbackUrl = (process.env.MIDTRANS_CALLBACK_BASE_URL || '').replace(/\/$/, '');

    // ─── Item Details ─────────────────────────────────────────────────────────
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

    // ─── Base Payload ─────────────────────────────────────────────────────────
    const payload: any = {
      transaction_details: {
        order_id: order.orderNumber,
        gross_amount: Math.round(order.finalAmount),
      },
      // Midtrans mengirim email notifikasi (VA number / QR code / instruksi bayar)
      // ke customer_details.email secara otomatis setelah charge berhasil dibuat.
      customer_details: {
        first_name: customerDetails.firstName,
        email: customerEmail,
        phone: customerDetails.phone,
      },
      item_details: itemDetails,
      // callbacks.finish: URL yang dibuka Midtrans setelah user selesai bayar.
      // Juga muncul sebagai link "Lihat Pesanan" di email notifikasi Midtrans.
      ...(baseCallbackUrl && {
        callbacks: { finish: `${baseCallbackUrl}/payment/finish` },
      }),
    };

    // ─── BANK TRANSFER ───────────────────────────────────────────────────────
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

    // ─── QRIS ────────────────────────────────────────────────────────────────
    // Satu QR code yang bisa di-scan oleh semua e-wallet (GoPay, OVO, Dana, dll).
    // ⚠️  Perlu aktivasi di Midtrans Dashboard → Settings → Payment Channels → QRIS
    } else if (paymentMethod === 'qris') {
      payload.payment_type = 'qris';
      payload.qris = { acquirer: 'gopay' };

    // ─── GOPAY ───────────────────────────────────────────────────────────────
    // Menggunakan QRIS acquirer gopay — BUKAN payment_type 'gopay' native.
    // 'payment_type: gopay' membutuhkan GoPay POP merchant partnership khusus
    // yang tidak tersedia di akun Midtrans standar (error: Merchant pop id is not found).
    // Solusi standar: kirim QRIS dengan acquirer gopay → user scan QR pakai app GoPay.
    // ⚠️  Perlu aktivasi QRIS di Midtrans Dashboard → Settings → Payment Channels → QRIS
    } else if (paymentMethod === 'gopay') {
      payload.payment_type = 'qris';
      payload.qris = { acquirer: 'gopay' };

    // ─── SHOPEEPAY ───────────────────────────────────────────────────────────
    // Menggunakan QRIS acquirer airpay shopee — BUKAN payment_type 'shopeepay' native.
    // payment_type 'shopeepay' membutuhkan aktivasi channel ShopeePay terpisah
    // (error: Payment channel is not activated).
    // Solusi standar yang lebih reliable: QRIS dengan acquirer airpay shopee.
    // ⚠️  Perlu aktivasi QRIS di Midtrans Dashboard → Settings → Payment Channels → QRIS
    } else if (paymentMethod === 'shopeepay') {
      payload.payment_type = 'qris';
      payload.qris = { acquirer: 'airpay shopee' };

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