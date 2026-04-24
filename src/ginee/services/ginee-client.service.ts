import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { GineeResponse } from '../ginee.types';

@Injectable()
export class GineeClientService {
  private readonly logger = new Logger(GineeClientService.name);
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    const rawUrl = this.config.get<string>('GINEE_OPEN_API_URL', 'https://api.ginee.com');
    this.baseUrl = rawUrl.replace(/\/$/, ''); // Remove trailing slash
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 15_000,
    });
  }

  private getCredentials() {
    const secretKey = this.config.get<string>('GINEE_SECRET_KEY', '').trim();
    const accessKey = this.config.get<string>('GINEE_ACCESS_KEY', '').trim();
    if (!secretKey || !accessKey) throw new Error('GINEE credentials missing');
    return { secretKey, accessKey };
  }

  private generateSignature(method: string, cleanPath: string): string {
    const { secretKey } = this.getCredentials();
    // Signature = Base64(HMAC-SHA256(SecretKey, Method + "$" + CleanUri + "$"))
    // CRITICAL: requestPath must NOT contain query parameters (e.g. ?productId=...)
    const signString = `${method.toUpperCase()}$${cleanPath}$`;

    return crypto
      .createHmac('sha256', secretKey)
      .update(signString)
      .digest('base64');
  }

  private getHeaders(method: string, cleanPath: string) {
    const { accessKey } = this.getCredentials();
    const signature = this.generateSignature(method, cleanPath);

    return {
      'Content-Type': 'application/json',
      'X-Advai-Country': 'ID',
      'Authorization': `${accessKey}:${signature}`,
    };
  }

  // ─── HTTP ────────────────────────────────────────────────────────────────────

  async post<T = any>(endpoint: string, payload: Record<string, any> = {}): Promise<GineeResponse<T>> {
    const path = this.normalizePath(endpoint);
    try {
      const headers = this.getHeaders('POST', path);
      // For POST, the path is clean, and payload goes in body
      const { data } = await this.http.post<any>(path, payload, { headers }); // Ubah tipe menjadi any sementara

      if (data.code !== 'SUCCESS' && data.code !== '200') {
        // 🔍 2. PERBAIKI PEMBACAAN PESAN ERROR (message vs msg):
        const errorReason = data.message || data.msg || JSON.stringify(data);
        throw new Error(`Ginee API Error [${data.code}]: ${errorReason}`);
      }
      return data;
    } catch (error: any) {
      this.handleError('POST', path, error);
      throw error;
    }
  }

  async get<T = any>(endpoint: string, params: Record<string, any> = {}): Promise<GineeResponse<T>> {
    const cleanPath = this.normalizePath(endpoint);
    let requestUrl = cleanPath;

    // Append query params ONLY to the Request URL, NOT the signing path
    if (Object.keys(params).length > 0) {
      const queryString = new URLSearchParams(params).toString();
      requestUrl = `${cleanPath}?${queryString}`;
    }

    try {
      const headers = this.getHeaders('GET', cleanPath);

      const { data } = await this.http.get<GineeResponse<T>>(requestUrl, { headers });

      if (data.code !== 'SUCCESS' && data.code !== '200') {
        throw new Error(`Ginee API Error [${data.code}]: ${data.msg}`);
      }
      return data;
    } catch (error: any) {
      this.handleError('GET', requestUrl, error);
      throw error;
    }
  }

  private normalizePath(endpoint: string): string {
    let path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return path.startsWith('/openapi') ? path : `/openapi${path}`;
  }

  private handleError(method: string, path: string, error: any) {
    const detail = error?.response?.data ?? error.message;
    this.logger.error(`[Ginee] ${method} ${path} failed:`, detail);
  }
}