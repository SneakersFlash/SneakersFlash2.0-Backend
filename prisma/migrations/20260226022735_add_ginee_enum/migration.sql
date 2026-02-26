-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GineeLogStatus" ADD VALUE 'completed';
ALTER TYPE "GineeLogStatus" ADD VALUE 'partial';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GineeLogType" ADD VALUE 'push_product';
ALTER TYPE "GineeLogType" ADD VALUE 'sync_all';

-- AlterEnum
ALTER TYPE "InventoryLogType" ADD VALUE 'order_adjustment';
