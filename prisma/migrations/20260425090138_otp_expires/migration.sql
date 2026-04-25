-- AlterTable
ALTER TABLE "users" ADD COLUMN     "otp_expires_at" TIMESTAMP(3),
ADD COLUMN     "tier_periode_end" TIMESTAMP(3),
ADD COLUMN     "tier_periode_start" TIMESTAMP(3),
ADD COLUMN     "total_order" INTEGER,
ADD COLUMN     "total_points_spent" DECIMAL(15,2) DEFAULT 0,
ADD COLUMN     "total_spent" DECIMAL(15,2) DEFAULT 0;
