import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { GineeResponse } from '../ginee.types';

/**
 * Low-level HTTP client for the Ginee Open API.
 * Handles authentication (HMAC-SHA256 signing) and response validation.
 *
 * ⚠️  Verify the signature spec against Ginee's official docs for your region —
 *     the signing string format can differ between API versions.
 */
@Injectable()
export class GineeClientService {
  private readonly logger = new Logger(GineeClientService.name);
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.http = axios.create({
      baseURL: this.config.get<string>('GINEE_OPEN_API_URL', 'https://api.ginee.com/openapi/v1'),
      timeout: 15_000,
    });
  }

  // ─── Signing ────────────────────────────────────────────────────────────────

  /**
   * Generates HMAC-SHA256 signature per Ginee API spec:
   *   signString = accessKey + timestamp + endpoint + sortedPayloadString
   *
   * The payload contribution is: sorted keys concatenated as "key=value&..."
   * (flat values only — nested objects are JSON-stringified).
   */
  private sign(endpoint: string, payload: Record<string, any>, timestamp: string): string {
    const accessKey = this.config.get<string>('GINEE_ACCESS_KEY', '');
    const secretKey = this.config.get<string>('GINEE_SECRET_KEY', '');

    const sortedPayload = Object.keys(payload)
      .sort()
      .map((k) => {
        const v = payload[k];
        return `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`;
      })
      .join('&');

    const signString = `${accessKey}${timestamp}${endpoint}${sortedPayload}`;

    return crypto
      .createHmac('sha256', secretKey)
      .update(signString)
      .digest('hex');
  }

  // ─── HTTP ────────────────────────────────────────────────────────────────────

  async post<T = any>(endpoint: string, payload: Record<string, any> = {}): Promise<GineeResponse<T>> {
    const accessKey = this.config.get<string>('GINEE_ACCESS_KEY', '');
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const headers = {
      'Content-Type': 'application/json',
      'X-Access-Key': accessKey,
      'X-Timestamp': timestamp,
      'X-Sign': this.sign(endpoint, payload, timestamp),
    };

    try {
      this.logger.debug(`[Ginee] POST ${endpoint}`);

      const { data } = await this.http.post<GineeResponse<T>>(endpoint, payload, { headers });

      if (data.code !== 'SUCCESS' && data.code !== '200') {
        this.logger.error(`[Ginee] API error on ${endpoint}`, { code: data.code, msg: data.msg });
        throw new Error(`Ginee API Error [${data.code}]: ${data.msg}`);
      }

      return data;
    } catch (error: any) {
      // Preserve Ginee error detail if it came from Axios response
      const detail = error?.response?.data ?? error.message;
      this.logger.error(`[Ginee] Request failed: POST ${endpoint}`, detail);
      throw error;
    }
  }

  /**
   * GET with query params (some Ginee endpoints use GET).
   */
  async get<T = any>(endpoint: string, params: Record<string, any> = {}): Promise<GineeResponse<T>> {
    const accessKey = this.config.get<string>('GINEE_ACCESS_KEY', '');
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const headers = {
      'X-Access-Key': accessKey,
      'X-Timestamp': timestamp,
      'X-Sign': this.sign(endpoint, params, timestamp),
    };

    try {
      this.logger.debug(`[Ginee] GET ${endpoint}`);
      const { data } = await this.http.get<GineeResponse<T>>(endpoint, { params, headers });

      if (data.code !== 'SUCCESS' && data.code !== '200') {
        throw new Error(`Ginee API Error [${data.code}]: ${data.msg}`);
      }

      return data;
    } catch (error: any) {
      const detail = error?.response?.data ?? error.message;
      this.logger.error(`[Ginee] Request failed: GET ${endpoint}`, detail);
      throw error;
    }
  }
}
