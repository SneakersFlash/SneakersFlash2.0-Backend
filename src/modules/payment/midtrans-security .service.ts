// src/payment/midtrans-security.service.ts
// Midtrans Security: Signature Validation + Safe Logging
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

// Interface untuk Midtrans notification payload
export interface MidtransNotification {
  order_id: string;
  status_code: string;
  gross_amount: string;
  signature_key: string;
  transaction_status: string;
  transaction_id: string;
  payment_type: string;
  transaction_time: string;
  fraud_status?: string;
  va_numbers?: Array<{ bank: string; va_number: string }>;
  payment_amounts?: Array<{ paid_at: string; amount: string }>;
}

// Tipe yang AMAN di-log (tanpa data sensitif)
type SafePaymentLog = {
  orderId: string;
  transactionStatus: string;
  paymentType: string;
  transactionTime: string;
  grossAmount: string;
  fraudStatus?: string;
  // TIDAK include: card numbers, CVV, customer PII
};

@Injectable()
export class MidtransSecurityService {
  private readonly logger = new Logger('MidtransPayment');
  private readonly serverKey: string;

  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('MIDTRANS_SERVER_KEY');
    if (!key) {
      throw new Error('MIDTRANS_SERVER_KEY is required');
    }
    this.serverKey = key;
  }

  /**
   * Validasi signature key dari Midtrans callback
   * WAJIB dipanggil sebelum memproses payment notification
   *
   * Formula: SHA512(order_id + status_code + gross_amount + server_key)
   */
  validateSignature(notification: MidtransNotification): boolean {
    const { order_id, status_code, gross_amount, signature_key } = notification;

    if (!order_id || !status_code || !gross_amount || !signature_key) {
      this.logger.warn('Invalid notification: missing required fields');
      return false;
    }

    const rawString = `${order_id}${status_code}${gross_amount}${this.serverKey}`;

    const expectedSignature = crypto
      .createHash('sha512')
      .update(rawString)
      .digest('hex');

    // Constant-time comparison untuk mencegah timing attack
    const isValid = crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(signature_key, 'hex'),
    );

    if (!isValid) {
      this.logger.warn(`Signature mismatch for order: ${order_id}`);
    }

    return isValid;
  }

  /**
   * Proses notification dengan validasi penuh
   */
  processNotification(payload: MidtransNotification): SafePaymentLog {
    // 1. Validasi signature terlebih dahulu
    if (!this.validateSignature(payload)) {
      throw new BadRequestException('Invalid payment notification signature');
    }

    // 2. Log hanya data yang AMAN (tidak ada PII/sensitif)
    const safeLog: SafePaymentLog = {
      orderId: payload.order_id,
      transactionStatus: payload.transaction_status,
      paymentType: payload.payment_type,
      transactionTime: payload.transaction_time,
      grossAmount: payload.gross_amount,
      fraudStatus: payload.fraud_status,
    };

    this.logger.log(`Payment notification: ${JSON.stringify(safeLog)}`);

    return safeLog;
  }

  /**
   * Mask card number untuk logging (4012xxxx1234)
   */
  maskCardNumber(cardNumber: string): string {
    if (!cardNumber || cardNumber.length < 8) return '****';
    return cardNumber.substring(0, 4) + 'x'.repeat(cardNumber.length - 8) + cardNumber.slice(-4);
  }

  /**
   * Sanitize amount: pastikan berupa angka valid
   */
  sanitizeAmount(amount: string | number): number {
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(num) || num <= 0) {
      throw new BadRequestException('Invalid amount');
    }
    return Math.round(num); // Selalu integer untuk Rupiah
  }
}
