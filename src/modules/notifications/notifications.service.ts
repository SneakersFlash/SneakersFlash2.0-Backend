import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Telegraf } from 'telegraf'; // <-- Tambahkan import ini

@Injectable()
export class NotificationsService {
    private transporter: nodemailer.Transporter;
    private bot?: Telegraf; // <-- Deklarasi bot
    private readonly logger = new Logger(NotificationsService.name);

    constructor() {
        // Setup SMTP (Gunakan Gmail atau Mailtrap untuk dev)
        this.transporter = nodemailer.createTransport({
            host: process.env.MAIL_HOST || 'smtp.gmail.com',
            port: Number(process.env.MAIL_PORT) || 587,
            secure: false, 
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

    // 2. Template Invoice (Tetap ada)
    async sendOrderInvoice(order: any) {
         // ... (Biarkan isinya sama seperti aslimu) ...
    }

    async sendPaymentInstructionEmail(to: string, orderNumber: string, amount: number, vaNumber: string | null, qrCodeUrl: string | null, paymentLink: string) {
        const subject = `Instruksi Pembayaran Pesanan ${orderNumber} - Sneakers Flash`;
        
        let paymentDetails = '';
        if (vaNumber) {
            paymentDetails = `<p><strong>Nomor Virtual Account (VA):</strong> <span style="font-size: 18px; color: #d9534f;">${vaNumber}</span></p>`;
        } else if (qrCodeUrl) {
            paymentDetails = `<p><strong>Link QR Code:</strong> <a href="${qrCodeUrl}">Klik di sini untuk melihat QR Code</a></p>`;
        }

        const html = `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <h2>Terima kasih atas pesanan Anda!</h2>
                <p>Pesanan Anda dengan nomor <b>${orderNumber}</b> telah berhasil dibuat dan menunggu pembayaran.</p>
                <p>Total Pembayaran: <b style="font-size: 18px;">Rp ${amount.toLocaleString('id-ID')}</b></p>
                ${paymentDetails}
                <br/>
                <p>Silakan selesaikan pembayaran Anda melalui tautan berikut (jika diperlukan):</p>
                <a href="${paymentLink}" style="padding: 10px 15px; background-color: #000; color: #fff; text-decoration: none; border-radius: 5px; font-weight: bold;">Selesaikan Pembayaran</a>
                <br/><br/>
                <p>Batas waktu pembayaran mengikuti instruksi dari channel pembayaran yang Anda pilih. Pesanan akan otomatis dibatalkan jika melewati batas waktu.</p>
                <br/>
                <p>Salam,<br/><b>Tim Sneakers Flash</b></p>
            </div>
        `;
        await this.sendEmail(to, subject, html);
    }

    // <-- TAMBAHAN 2: EMAIL OTP REGISTRASI -->
    async sendOtpEmail(to: string, otp: string) {
        const subject = 'Kode OTP Registrasi - Sneakers Flash';
        const html = `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; text-align: center;">
                <h2>Selamat Datang di Sneakers Flash!</h2>
                <p>Gunakan kode OTP berikut untuk memverifikasi pendaftaran akun Anda:</p>
                <h1 style="letter-spacing: 5px; color: #d9534f; background: #f9f9f9; padding: 10px; border-radius: 5px; display: inline-block;">${otp}</h1>
                <p>Kode ini berlaku selama <b>5 menit</b>. Jangan berikan kode ini kepada siapa pun, termasuk pihak Sneakers Flash.</p>
                <br/>
                <p>Terima kasih,<br/><b>Tim Sneakers Flash</b></p>
            </div>
        `;
        await this.sendEmail(to, subject, html);
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