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

    // <-- 3. TAMBAHAN FUNGSI NOTIFIKASI GUDANG (TELEGRAM) -->
    async sendWarehouseAlert(orderId: string, status: string, items: any[] = []) {
        if (!this.bot) {
          this.logger.error('Telegram bot tidak siap. Pastikan TELEGRAM_BOT_TOKEN ada di .env');
          return;
        }
        try {
            const chatId = process.env.TELEGRAM_WAREHOUSE_GROUP_ID;
            if (!chatId) {
                this.logger.error('TELEGRAM_WAREHOUSE_GROUP_ID belum disetting di .env!');
                return;
            }

            // Ekstrak nama barang jika ada di payload Ginee
            let itemsList = '';
            if (items && items.length > 0) {
                itemsList = items.map(i => `- ${i.productName || i.sku} (x${i.quantity || 1})`).join('\n');
            } else {
                itemsList = '- Menunggu detail sinkronisasi...';
            }

            const message = `🚨 <b>PESANAN BARU MASUK!</b> 🚨\n\n` +
                            `<b>Order ID Ginee:</b> <code>${orderId}</code>\n` +
                            `<b>Status:</b> ${status}\n\n` +
                            `<b>Daftar Barang:</b>\n${itemsList}\n\n` +
                            `Tolong segera dipersiapkan!`;

            // --- PERUBAHAN DI SINI: parse_mode diubah menjadi 'HTML' ---
            await this.bot.telegram.sendMessage(chatId, message, {
                parse_mode: 'HTML',
            });
            
            this.logger.log(`Notifikasi gudang via Telegram terkirim untuk order: ${orderId}`);
        } catch (error) {
            this.logger.error('Gagal mengirim notifikasi Telegram:', error);
        }
    }
}