-- AlterTable
ALTER TABLE "products" ADD COLUMN     "sku_parent" TEXT;

-- AlterTable
ALTER TABLE "user_addresses" ADD COLUMN     "latitude" INTEGER,
ADD COLUMN     "longitude" INTEGER;
