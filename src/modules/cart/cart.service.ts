import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart.dto';

@Injectable()
export class CartService {
  constructor(private prisma: PrismaService) {}

  // 1. Tambah ke Keranjang
  async addToCart(userId: number, dto: AddToCartDto) {
    const variantId = BigInt(dto.productVariantId);

    // A. Cek Barang & Stok
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
    });

    if (!variant) throw new NotFoundException('Produk tidak ditemukan');
    if (variant.stockQuantity < dto.quantity) {
      throw new BadRequestException(`Stok tidak cukup! Sisa: ${variant.stockQuantity}`);
    }

    // B. Cari/Buat Keranjang User (Find or Create)
    let cart = await this.prisma.cart.findUnique({
      where: { userId: BigInt(userId) },
    });

    if (!cart) {
      cart = await this.prisma.cart.create({
        data: { userId: BigInt(userId) },
      });
    }

    // C. Cek apakah item sudah ada di keranjang?
    const existingItem = await this.prisma.cartItem.findFirst({
      where: {
        cartId: cart.id,
        productVariantId: variantId,
      },
    });

    if (existingItem) {
      // Logic: Update Quantity (Barang lama + Barang baru)
      // Cek stok lagi untuk total quantity
      if (variant.stockQuantity < existingItem.quantity + dto.quantity) {
         throw new BadRequestException('Stok total tidak mencukupi');
      }

      return this.prisma.cartItem.update({
        where: { id: existingItem.id },
        data: { quantity: existingItem.quantity + dto.quantity },
      });
    } else {
      // Logic: Bikin Item Baru
      return this.prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productVariantId: variantId,
          quantity: dto.quantity,
        },
      });
    }
  }

  // 2. Lihat Keranjang Saya
  async getMyCart(userId: number) {
    const cart = await this.prisma.cart.findUnique({
      where: { userId: BigInt(userId) },
      include: {
        cartItems: {
          orderBy: { createdAt: 'desc' },
          include: {
            variant: {
              include: { product: true } // Ambil Nama Produk & Gambar
            } 
          }
        }
      }
    });

    if (!cart) return { items: [], total: 0 };

    // Format Data biar Frontend enak bacanya (Hitung Subtotal)
    const items = cart.cartItems.map(item => ({
      id: item.id.toString(), // Convert BigInt to String
      productName: item.variant.product.name,
      variantSku: item.variant.sku,
      price: Number(item.variant.price),
      quantity: item.quantity,
      subtotal: Number(item.variant.price) * item.quantity,
      image: item.variant.imageUrl // Fallback image
    }));

    const grandTotal = items.reduce((sum, item) => sum + item.subtotal, 0);

    return {
      cartId: cart.id.toString(),
      items,
      grandTotal
    };
  }

  // 3. Update Jumlah Item
  async updateItem(userId: number, cartItemId: number, dto: UpdateCartItemDto) {
    // Pastikan item ini milik user tersebut (Security Check)
    const item = await this.prisma.cartItem.findFirst({
        where: { 
            id: BigInt(cartItemId),
            cart: { userId: BigInt(userId) } // Relasi ke User
        }
    });

    if (!item) throw new NotFoundException('Item tidak ditemukan di keranjangmu');

    return this.prisma.cartItem.update({
        where: { id: BigInt(cartItemId) },
        data: { quantity: dto.quantity }
    });
  }

  // 4. Hapus Item
  async removeItem(userId: number, cartItemId: number) {
    const item = await this.prisma.cartItem.findFirst({
        where: { 
            id: BigInt(cartItemId),
            cart: { userId: BigInt(userId) }
        }
    });

    if (!item) throw new NotFoundException('Item tidak ditemukan');

    return this.prisma.cartItem.delete({
        where: { id: BigInt(cartItemId) }
    });
  }
}