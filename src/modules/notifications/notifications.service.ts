import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Telegraf } from 'telegraf'; // <-- Tambahkan import ini

@Injectable()
export class NotificationsService {
    private transporter: nodemailer.Transporter;
    private bot?: Telegraf; // <-- Deklarasi bot
    private readonly logger = new Logger(NotificationsService.name);

    private readonly primaryColor = '#F6E70A';
    private readonly logoUrl = `${process.env.APP_URL || 'https://api.sneakersflash.com'}/uploads/logo_basic_white.png`;

    constructor() {
        // Setup SMTP 
        this.transporter = nodemailer.createTransport({
            host: process.env.MAIL_HOST || 'smtp.hostinger.com',
            port: Number(process.env.MAIL_PORT) || 465,
            // Jika port 465, secure wajib true. Jika 587, secure false.
            secure: Number(process.env.MAIL_PORT) === 465, 
            auth: {
                user: process.env.MAIL_USER, 
                pass: process.env.MAIL_PASS, 
            },
        });

        // <-- TAMBAHAN SETUP TELEGRAM BOT -->
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (token) {
            this.bot = new Telegraf(token);
            this.logger.log('Telegram Bot initialized successfully.');
        } else {
            this.logger.warn('TELEGRAM_BOT_TOKEN belum disetting di .env');
        }
    }

    // 1. Fungsi Dasar Kirim Email (Tetap ada)
    async sendEmail(to: string, subject: string, html: string) {
        // ... (Biarkan isinya sama seperti aslimu) ...
        try {
            await this.transporter.sendMail({
                from: `"Sneakers Flash" <${process.env.MAIL_USER}>`,
                to,
                subject,
                html,
            });
            this.logger.log(`Email terkirim ke: ${to}`);
        } catch (error: any) {
            this.logger.error(`Gagal kirim email: ${error.message}`);
        }
    }

    async sendOtpEmail(to: string, otp: string) {
        const subject = 'Kode Verifikasi Anda - Sneakers Flash';
        const html = `
            <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f4f4; padding: 40px 0;">
                <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
                    <div style="background-color: #000; padding: 20px; text-align: center;">
                        <img src="${this.logoUrl}" alt="Sneakers Flash" style="height: 40px;">
                    </div>
                    <div style="padding: 40px; text-align: center;">
                        <h2 style="margin-top: 0; color: #333;">Verifikasi Akun</h2>
                        <p style="color: #666; font-size: 16px;">Gunakan kode OTP di bawah ini untuk menyelesaikan pendaftaran Anda.</p>
                        <div style="background-color: ${this.primaryColor}; color: #000; font-size: 32px; font-weight: bold; letter-spacing: 8px; padding: 20px; border-radius: 8px; margin: 30px 0; display: inline-block; width: 80%;">
                            ${otp}
                        </div>
                        <p style="color: #999; font-size: 13px;">Kode ini berlaku selama 5 menit. Jangan bagikan kode ini kepada siapapun.</p>
                    </div>
                    <div style="background-color: #fafafa; padding: 20px; text-align: center; color: #bbb; font-size: 12px;">
                        &copy; 2026 Sneakers Flash. All Rights Reserved.
                    </div>
                </div>
            </div>
        `;
        await this.sendEmail(to, subject, html);
    }

    // 2. Instruksi Pembayaran - Action Oriented
    async sendPaymentInstructionEmail(to: string, orderNumber: string, amount: number, vaNumber: string | null, qrCodeUrl: string | null, paymentLink: string) {
        const subject = `Selesaikan Pembayaran Pesanan ${orderNumber}`;
        
        let paymentSection = '';
        if (vaNumber) {
            paymentSection = `
                <p style="margin-bottom: 5px; color: #666;">Nomor Virtual Account:</p>
                <div style="font-size: 24px; font-weight: bold; color: #000; margin-bottom: 20px;">${vaNumber}</div>
            `;
        } else if (qrCodeUrl) {
            paymentSection = `<div style="margin: 20px 0;"><img src="${qrCodeUrl}" alt="QR Code" style="width: 200px; border: 1px solid #eee;"></div>`;
        }

        const html = `
            <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f9f9f9; padding: 40px 0;">
                <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #eee;">
                    <div style="background-color: ${this.primaryColor}; padding: 25px; text-align: center;">
                        <img src="${this.logoUrl}" alt="Sneakers Flash" style="height: 45px;">
                    </div>
                    <div style="padding: 40px; text-align: center;">
                        <h2 style="color: #000; margin-top: 0;">Hampir Selesai!</h2>
                        <p style="color: #666;">Silakan selesaikan pembayaran untuk pesanan <strong>${orderNumber}</strong> agar barang Anda segera kami siapkan.</p>
                        
                        <div style="margin: 30px 0; padding: 20px; border: 2px dashed #ddd; border-radius: 10px;">
                            <p style="margin: 0 0 5px 0; color: #666;">Total Tagihan:</p>
                            <h2 style="margin: 0; color: #28a745;">Rp ${amount.toLocaleString('id-ID')}</h2>
                            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                            ${paymentSection}
                            <a href="${paymentLink}" style="display: inline-block; padding: 15px 30px; background-color: #000; color: #fff; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">Bayar Sekarang</a>
                        </div>
                    </div>
                </div>
            </div>
        `;
        await this.sendEmail(to, subject, html);
    }

    // 3. Invoice Lunas - Professional Receipt
    async sendOrderInvoice(order: any) {
        const email = order.user?.email;
        if (!email) return;

        const subject = `Invoice Pesanan ${order.orderNumber} - Sneakers Flash`;
        const orderItems = order.items || order.orderItems || [];
        const itemsHtml = orderItems.map((item: any) => `
            <tr>
                <td style="padding: 12px 0; border-bottom: 1px solid #eee;">
                    <div style="font-weight: bold; color: #333;">${item.productName || '-'}</div>
                    <div style="font-size: 12px; color: #888;">SKU: ${item.variantSku || item.sku || '-'} | Size: ${item.size || '-'}</div>
                </td>
                <td style="padding: 12px 0; border-bottom: 1px solid #eee; text-align: center; color: #666;">${item.quantity}</td>
                <td style="padding: 12px 0; border-bottom: 1px solid #eee; text-align: right; color: #333;">Rp ${Number(item.subtotal || 0).toLocaleString('id-ID')}</td>
            </tr>
        `).join('');

        const html = `
            <div style="font-family: 'Helvetica Neue', Arial, sans-serif; color: #444; background-color: #f4f4f4; padding: 40px 0;">
                <div style="max-width: 600px; margin: 0 auto; background-color: #fff; padding: 40px; border-radius: 8px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                         <img src="${this.logoUrl}" alt="Logo" style="height: 50px; filter: invert(1);">
                         <h3 style="margin-top: 10px; color: #000; letter-spacing: 1px;">INVOICE PENJUALAN</h3>
                    </div>

                    <div style="margin-bottom: 30px; font-size: 14px;">
                        <table style="width: 100%;">
                            <tr>
                                <td><span style="color: #999;">No. Pesanan:</span><br><strong>${order.orderNumber}</strong></td>
                                <td style="text-align: right;"><span style="color: #999;">Tanggal:</span><br><strong>${new Date(order.createdAt).toLocaleDateString('id-ID', { dateStyle: 'long' })}</strong></td>
                            </tr>
                        </table>
                    </div>

                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                        <thead>
                            <tr style="text-align: left; font-size: 12px; text-transform: uppercase; color: #999; border-bottom: 2px solid #000;">
                                <th style="padding-bottom: 10px;">Item</th>
                                <th style="padding-bottom: 10px; text-align: center;">Qty</th>
                                <th style="padding-bottom: 10px; text-align: right;">Total</th>
                            </tr>
                        </thead>
                        <tbody>${itemsHtml}</tbody>
                    </table>

                    <div style="margin-left: auto; width: 250px; font-size: 14px;">
                        <table style="width: 100%;">
                            <tr><td style="padding: 5px 0;">Subtotal</td><td style="text-align: right;">Rp ${Number(order.subtotal || 0).toLocaleString('id-ID')}</td></tr>
                            <tr><td style="padding: 5px 0;">Ongkir</td><td style="text-align: right;">Rp ${Number(order.shippingCost || 0).toLocaleString('id-ID')}</td></tr>
                            ${order.discountTotal ? `<tr><td style="padding: 5px 0; color: #d9534f;">Diskon</td><td style="text-align: right; color: #d9534f;">-Rp ${Number(order.discountTotal).toLocaleString('id-ID')}</td></tr>` : ''}
                            <tr style="font-weight: bold; font-size: 18px; color: #000;">
                                <td style="padding: 15px 0; border-top: 2px solid ${this.primaryColor};">TOTAL</td>
                                <td style="padding: 15px 0; border-top: 2px solid ${this.primaryColor}; text-align: right;">Rp ${Number(order.total || order.finalAmount).toLocaleString('id-ID')}</td>
                            </tr>
                        </table>
                    </div>

                    <div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px; margin-top: 30px; font-size: 13px;">
                        <h4 style="margin: 0 0 10px 0; text-transform: uppercase;">Alamat Pengiriman</h4>
                        <p style="margin: 0; line-height: 1.5;">
                            <strong>${order.address?.recipientName || order.shippingRecipientName}</strong><br>
                            ${order.address?.street || order.shippingAddressLine}, ${order.address?.city || order.shippingCity}<br>
                            ${order.address?.phone || order.shippingPhone}
                        </p>
                    </div>
                </div>
            </div>
        `;
        await this.sendEmail(email, subject, html);
    }
    
    // 3. Fungsi Notifikasi Gudang (Telegram)
    async sendWarehouseAlert(orderId: string, status: string, items: any[] = [], channel: string = '-', payAt: string = '-', externalOrderId: string = '-') {
        if (!this.bot) {
            this.logger.error('Telegram bot tidak siap. Pastikan TELEGRAM_BOT_TOKEN ada di .env');
            return;
        }

        try {
            const chatId = process.env.TELEGRAM_WAREHOUSE_GROUP_ID;
            if (!chatId) return;

            // --- Format Waktu ke WIB (Waktu Indonesia Barat) ---
            let payAtFormatted = payAt;
            if (payAt !== '-') {
                try {
                    const dateObj = new Date(payAt);
                    // Menghasilkan format: "15 April 2026 13:08:59 WIB"
                    payAtFormatted = dateObj.toLocaleString('id-ID', { 
                        timeZone: 'Asia/Jakarta', 
                        dateStyle: 'long', 
                        timeStyle: 'medium' 
                    }) + ' WIB';
                } catch (e) {
                    payAtFormatted = payAt; // Fallback jika gagal format
                }
            }

            // --- Format Daftar Barang (Nama + Variasi + SKU + Qty) ---
            let itemsList = '';
            if (items && items.length > 0) {
                itemsList = items.map(i => {
                    const name = i.productName || i.sku || 'Produk Tidak Diketahui';
                    const variant = i.variationName ? `[Variasi: <b>${i.variationName}</b>]` : '';
                    const sku = i.sku ? `(SKU: <code>${i.sku}</code>)` : '';
                    const qty = i.quantity || 1;
                    
                    return `- ${name} ${variant} ${sku} <b>(x${qty})</b>`;
                }).join('\n\n'); // Menggunakan \n\n agar ada jarak antar barang
            } else {
                itemsList = '- Menunggu detail sinkronisasi...';
            }

            // --- Template Pesan HTML ---
            const message = `🚨 <b>PESANAN BARU MASUK!</b> 🚨\n\n` +
                            `<b>No Order (Ginee):</b> <code>${orderId}</code>\n` +
                            `<b>No Order (${channel}):</b> <code>${externalOrderId}</code>\n` +
                            `<b>Channel:</b> ${channel}\n` +
                            `<b>Status:</b> ${status}\n` +
                            `<b>Waktu Bayar:</b> ${payAtFormatted}\n\n` +
                            `<b>Daftar Barang:</b>\n${itemsList}\n\n` +
                            `Tolong segera dipersiapkan! 📦`;

            await this.bot.telegram.sendMessage(chatId, message, {
                parse_mode: 'HTML',
            });
            
            this.logger.log(`Notifikasi gudang via Telegram terkirim untuk order: ${orderId}`);
        } catch (error) {
            this.logger.error('Gagal mengirim notifikasi Telegram:', error);
        }
    }
}