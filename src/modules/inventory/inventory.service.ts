import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateInventoryDto } from './dto/create-inventory.dto';

@Injectable()
export class InventoryService {
  constructor(private prisma: PrismaService) {}

  // Fitur 1: Adjust Stok (Tambah/Kurang)
  async adjustStock(dto: CreateInventoryDto) {
    const variantId = BigInt(dto.productVariantId);

    // 1. Cek Varian Ada?
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
    });
    if (!variant) throw new NotFoundException('Varian produk tidak ditemukan');

    // 2. Cek Stok Cukup? (Khusus pengurangan)
    const newStock = variant.stockQuantity + dto.quantityChange;
    if (newStock < 0) {
      throw new BadRequestException(
        `Stok tidak cukup! Stok saat ini: ${variant.stockQuantity}, Diminta kurangi: ${Math.abs(dto.quantityChange)}`
      );
    }

    // 3. TRANSACTION: Update Stok + Catat Log
    // (Atomic Operation: Gagal satu, batal semua)
    return this.prisma.$transaction(async (tx) => {
      // A. Update Stok di Master Data
      const updatedVariant = await tx.productVariant.update({
        where: { id: variantId },
        data: { stockQuantity: newStock },
      });

      // B. Catat Riwayat (Log)
      const log = await tx.inventoryLog.create({
        data: {
          productVariantId: variantId,
          quantityChange: dto.quantityChange,
          type: dto.type,
          note: dto.note,
          referenceId: dto.referenceId,
        },
      });

      return {
        message: 'Stok berhasil diperbarui',
        currentStock: updatedVariant.stockQuantity,
        logDetail: log,
      };
    });
  }

  // Fitur 2: Lihat Riwayat Stok per Varian (Kartu Stok)
  async getHistory(variantId: number) {
    const logs = await this.prisma.inventoryLog.findMany({
      where: { productVariantId: BigInt(variantId) },
      orderBy: { createdAt: 'desc' }, 
      include: {
        variant: {
          select: { sku: true } 
        }
      }
    });

    // Wajib di-map untuk mengubah BigInt menjadi string
    return logs.map(log => ({
      ...log,
      id: log.id.toString(),
      productVariantId: log.productVariantId.toString(),
    }));
  }

  // (Optional) CRUD standar kita hapus saja karena tidak relevan
  findAll() { return 'Gunakan getHistory per varian'; }
  findOne(id: number) { return `Log ID #${id}`; }
  remove(id: number) { return 'Dilarang menghapus log inventory!'; }
}