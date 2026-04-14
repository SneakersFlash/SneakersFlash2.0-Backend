-- CreateTable
CREATE TABLE "user_claimed_vouchers" (
    "user_id" BIGINT NOT NULL,
    "voucher_id" BIGINT NOT NULL,
    "is_used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_claimed_vouchers_pkey" PRIMARY KEY ("user_id","voucher_id")
);

-- AddForeignKey
ALTER TABLE "user_claimed_vouchers" ADD CONSTRAINT "user_claimed_vouchers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_claimed_vouchers" ADD CONSTRAINT "user_claimed_vouchers_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
