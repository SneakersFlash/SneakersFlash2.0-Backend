import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AddWishlistDto } from './dto/add-wishlist.dto';
import { WishlistQueryDto } from './dto/wishlist-query.dto';

// ── Reusable select shapes ────────────────────────────────────────────────────

const productSelect = {
  id: true,
  name: true,
  slug: true,
  basePrice: true,
  ratingAvg: true,
  reviewCount: true,
  brand: {
    select: { id: true, name: true, slug: true, logoUrl: true },
  },
  categories: {
    select: { id: true, name: true, slug: true },
  },
  variants: {
    where: { isActive: true },
    select: {
      id: true,
      sku: true,
      price: true,
      stockQuantity: true,
      imageUrl: true,
    },
    take: 1, // preview image only
  },
};

const variantSelect = {
  id: true,
  sku: true,
  price: true,
  stockQuantity: true,
  imageUrl: true,
  isActive: true,
  variantOptions: {
    select: {
      optionValue: {
        select: {
          id: true,
          value: true,
          option: { select: { id: true, name: true } },
        },
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class WishlistService {
  constructor(private readonly prisma: PrismaService) {}

  // ── GET /wishlists ──────────────────────────────────────────────────────────
  async findAll(userId: number, query: WishlistQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const uid = BigInt(userId);

    const [items, total] = await Promise.all([
      this.prisma.wishlist.findMany({
        where: { userId: uid },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          product: { select: productSelect },
          variant: { select: variantSelect },
        },
      }),
      this.prisma.wishlist.count({ where: { userId: uid } }),
    ]);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ── GET /wishlists/check/:productId ─────────────────────────────────────────
  async check(userId: number, productId: number, variantId?: number) {
    const item = await this.prisma.wishlist.findFirst({
      where: {
        userId: BigInt(userId),
        productId: BigInt(productId),
        ...(variantId !== undefined
          ? { productVariantId: BigInt(variantId) }
          : {}),
      },
      select: { id: true },
    });

    return {
      wishlisted: !!item,
      wishlistId: item ? Number(item.id) : null,
    };
  }

  // ── POST /wishlists ─────────────────────────────────────────────────────────
  async add(userId: number, dto: AddWishlistDto) {
    const uid = BigInt(userId);
    const productId = BigInt(dto.productId);
    const variantId = dto.productVariantId
      ? BigInt(dto.productVariantId)
      : null;

    // 1. Product must exist and be active
    const product = await this.prisma.product.findFirst({
      where: { id: productId, isActive: true },
      select: { id: true },
    });
    if (!product) {
      throw new NotFoundException('Product not found or inactive.');
    }

    // 2. Variant must belong to the product and be active (if provided)
    if (variantId) {
      const variant = await this.prisma.productVariant.findFirst({
        where: { id: variantId, productId, isActive: true },
        select: { id: true },
      });
      if (!variant) {
        throw new NotFoundException(
          'Variant not found, inactive, or does not belong to this product.',
        );
      }
    }

    // 3. Duplicate guard
    const existing = await this.prisma.wishlist.findFirst({
      where: { userId: uid, productId, productVariantId: variantId },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Item is already in your wishlist.');
    }

    // 4. Create
    const item = await this.prisma.wishlist.create({
      data: { userId: uid, productId, productVariantId: variantId },
      select: {
        id: true,
        createdAt: true,
        product: { select: productSelect },
        variant: { select: variantSelect },
      },
    });

    return { data: item };
  }

  // ── DELETE /wishlists/:id ───────────────────────────────────────────────────
  async remove(userId: number, id: number) {
    const uid = BigInt(userId);
    const wid = BigInt(id);

    const item = await this.prisma.wishlist.findFirst({
      where: { id: wid, userId: uid },
      select: { id: true },
    });
    if (!item) {
      throw new NotFoundException('Wishlist item not found.');
    }

    await this.prisma.wishlist.delete({ where: { id: wid } });

    return { data: { id } };
  }

  // ── DELETE /wishlists ───────────────────────────────────────────────────────
  async clear(userId: number) {
    const { count } = await this.prisma.wishlist.deleteMany({
      where: { userId: BigInt(userId) },
    });

    return { data: { deletedCount: count } };
  }
}
