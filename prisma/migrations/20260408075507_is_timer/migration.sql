-- AlterTable
ALTER TABLE "events" ADD COLUMN     "is_timer" BOOLEAN DEFAULT false,
ADD COLUMN     "sort" INTEGER;
