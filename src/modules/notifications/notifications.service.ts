import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class NotificationsService {
    private transporter: nodemailer.Transporter;
    private readonly logger = new Logger(NotificationsService.name);

    constructor() {
        // Setup SMTP (Gunakan Gmail atau Mailtrap untuk dev)
        this.transporter = nodemailer.createTransport({
            host: process.env.MAIL_HOST || 'smtp.gmail.com',
            port: Number(process.env.MAIL_PORT) || 587,
            secure: false, // true for 465, false for other ports
            auth: {
                user: process.env.MAIL_USER, // Email pengirim
                pass: process.env.MAIL_PASS, // App Password (bukan password login biasa)
            },
        });
    }

    // 1. Fungsi Dasar Kirim Email
    async sendEmail(to: string, subject: string, html: string) {
        try {
            await this.transporter.sendMail({
                from: `"Sneakers Flash" <${process.env.MAIL_USER}>`,
                to,
                subject,
                html,
            });
            this.logger.log(`Email terkirim ke: ${to}`);
        } catch (error) {
            this.logger.error(`Gagal kirim email: ${error.message}`);
        }
    }

    // 2. Template Invoice (Dipanggil saat Payment Sukses)
    async sendOrderInvoice(order: any) {
        const rupiah = (num: number) =>
            new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(num);

        const itemsHtml = order.orderItems.map((item: any) => `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">${item.productName} (${item.variantName})</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">x${item.quantity}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">${rupiah(Number(item.price))}</td>
      </tr>
    `).join('');

        const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px;">
        <h2 style="color: #333;">Terima Kasih, Pesanan Terkonfirmasi! 🎉</h2>
        <p>Halo <strong>${order.shippingRecipientName}</strong>,</p>
        <p>Pembayaran untuk pesanan <strong>#${order.orderNumber}</strong> telah kami terima.</p>
        
        <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
          <thead>
            <tr style="background-color: #f8f9fa;">
              <th style="padding: 10px; text-align: left;">Produk</th>
              <th style="padding: 10px; text-align: left;">Qty</th>
              <th style="padding: 10px; text-align: right;">Harga</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>

        <div style="margin-top: 20px; text-align: right;">
          <p>Subtotal: ${rupiah(Number(order.subtotal))}</p>
          <p>Ongkir: ${rupiah(Number(order.shippingCost))}</p>
          <p style="color: red;">Diskon: -${rupiah(Number(order.discountTotal))}</p>
          <h3 style="color: #28a745;">Total Bayar: ${rupiah(Number(order.finalAmount))}</h3>
        </div>

        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="font-size: 12px; color: #777;">
          Alamat Pengiriman:<br>
          ${order.shippingAddressLine}, ${order.shippingCity}, ${order.shippingPostalCode}
        </p>
      </div>
    `;

        // Asumsikan kita punya email user dari relasi atau dummy dulu
        // Di real case: ambil order.user.email
        const userEmail = 'customer@sneakersflash.com'; // Ganti dengan order.user.email nanti

        await this.sendEmail(userEmail, `Invoice Pesanan #${order.orderNumber}`, html);
    }
}