import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

@Injectable()
export class GineeClientService {
    private readonly logger = new Logger(GineeClientService.name);
    private axiosInstance: AxiosInstance;
    private config = {
        baseUrl: process.env.GINEE_OPEN_API_URL || 'https://api.ginee.com/openapi/v1',
        accessKey: process.env.GINEE_ACCESS_KEY,
        secretKey: process.env.GINEE_SECRET_KEY,
        shopId: process.env.GINEE_SHOP_ID,
    };

    constructor() {
        this.axiosInstance = axios.create({
        baseURL: this.config.baseUrl,
        timeout: 10000,
        });
    }

    // Generate Signature sesuai dokumentasi Ginee
    private generateSignature(params: Record<string, any>, timestamp: string): string {
        // 1. Sort params keys
        const sortedKeys = Object.keys(params).sort();
        
        // 2. Concat string: key + value
        let signString = '';
        for (const key of sortedKeys) {
        signString += key + (typeof params[key] === 'object' ? JSON.stringify(params[key]) : params[key]);
        }
        
        // 3. Tambahkan Secret di depan dan belakang (Contoh pattern umum, cek doks Ginee spesifik v1/v2)
        // Note: Cek dokumentasi Ginee terbaru apakah pakai HMAC-SHA256 atau MD5 concatenation
        // Ini contoh implementasi HMAC-SHA256 yang umum:
        const hmac = crypto.createHmac('sha256', this.config.secretKey || '');
        hmac.update(`${this.config.accessKey}${timestamp}${signString}`);
        return hmac.digest('hex');
    }

    async post<T>(endpoint: string, payload: any = {}): Promise<T> {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        
        // Ginee biasanya minta Auth di Header atau Query Params
        // Asumsi implementasi standard:
        const headers = {
        'X-Access-Key': this.config.accessKey,
        'X-Timestamp': timestamp,
        'X-Sign': this.generateSignature(payload, timestamp),
        'Content-Type': 'application/json',
        };

        try {
        this.logger.debug(`Sending Request to ${endpoint}`, payload);
        const response = await this.axiosInstance.post<T>(endpoint, payload, { headers });
        
        // Handle Ginee Business Error (HTTP 200 tapi code != "SUCCESS")
        if (response.data['code'] !== 'SUCCESS' && response.data['code'] !== '200') {
            throw new Error(`Ginee API Error: ${response.data['msg']} (${response.data['code']})`);
        }

        return response.data;
        } catch (error: any) {
        this.logger.error(`Failed request to ${endpoint}`, error.response?.data || error.message);
        throw error;
        }
    }
}