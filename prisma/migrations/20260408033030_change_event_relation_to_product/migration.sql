/*
  Warnings:

  - The primary key for the `event_products` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `product_variant_id` on the `event_products` table. All the data in the column will be lost.
  - Added the required column `product_id` to the `event_products` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "event_products" DROP CONSTRAINT "event_products_product_variant_id_fkey";

-- AlterTable
ALTER TABLE "event_products" DROP CONSTRAINT "event_products_pkey",
DROP COLUMN "product_variant_id",
ADD COLUMN     "product_id" BIGINT NOT NULL,
ADD CONSTRAINT "event_products_pkey" PRIMARY KEY ("event_id", "product_id");

-- AddForeignKey
ALTER TABLE "event_products" ADD CONSTRAINT "event_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
