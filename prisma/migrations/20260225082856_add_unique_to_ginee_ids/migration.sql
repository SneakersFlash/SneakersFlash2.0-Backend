/*
  Warnings:

  - A unique constraint covering the columns `[ginee_sku_id]` on the table `product_variants` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[ginee_product_id]` on the table `products` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "product_variants_ginee_sku_id_key" ON "product_variants"("ginee_sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_ginee_product_id_key" ON "products"("ginee_product_id");
