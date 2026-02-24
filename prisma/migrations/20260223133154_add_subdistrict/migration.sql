/*
  Warnings:

  - Added the required column `shipping_phone` to the `orders` table without a default value. This is not possible if the table is not empty.
  - Added the required column `shipping_subdistrict_id` to the `orders` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "komerce_order_id" TEXT,
ADD COLUMN     "shipping_district" TEXT,
ADD COLUMN     "shipping_phone" TEXT NOT NULL,
ADD COLUMN     "shipping_province" TEXT,
ADD COLUMN     "shipping_subdistrict_id" INTEGER NOT NULL,
ADD COLUMN     "total_weight_grams" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "user_addresses" ADD COLUMN     "subdistrict_id" INTEGER;

-- CreateTable
CREATE TABLE "ind_subdistricts" (
    "id" INTEGER NOT NULL,
    "district_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "postal_code" TEXT,

    CONSTRAINT "ind_subdistricts_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ind_subdistricts" ADD CONSTRAINT "ind_subdistricts_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "ind_districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
