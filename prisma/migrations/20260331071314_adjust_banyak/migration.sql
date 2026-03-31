/*
  Warnings:

  - The primary key for the `event_products` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `product_id` on the `event_products` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[session_id]` on the table `carts` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[google_id]` on the table `users` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `product_variant_id` to the `event_products` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "event_products" DROP CONSTRAINT "event_products_product_id_fkey";

-- AlterTable
ALTER TABLE "carts" ADD COLUMN     "session_id" TEXT;

-- AlterTable
ALTER TABLE "event_products" DROP CONSTRAINT "event_products_pkey",
DROP COLUMN "product_id",
ADD COLUMN     "product_variant_id" BIGINT NOT NULL,
ADD CONSTRAINT "event_products_pkey" PRIMARY KEY ("event_id", "product_variant_id");

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "available_stock" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reserved_stock" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "tags" TEXT[];

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "google_id" TEXT,
ALTER COLUMN "password" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "carts_session_id_key" ON "carts"("session_id");

-- CreateIndex
CREATE INDEX "carts_session_id_idx" ON "carts"("session_id");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");

-- CreateIndex
CREATE INDEX "orders_order_number_idx" ON "orders"("order_number");

-- CreateIndex
CREATE INDEX "product_variants_sku_idx" ON "product_variants"("sku");

-- CreateIndex
CREATE INDEX "products_slug_idx" ON "products"("slug");

-- CreateIndex
CREATE INDEX "products_is_active_idx" ON "products"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- AddForeignKey
ALTER TABLE "event_products" ADD CONSTRAINT "event_products_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
