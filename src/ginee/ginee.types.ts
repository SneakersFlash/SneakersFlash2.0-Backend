// ─── Ginee API Config ────────────────────────────────────────────────────────

export interface GineeConfig {
  baseUrl: string;
  accessKey: string;
  secretKey: string;
  shopId: string;
}

// ─── Generic API Response ─────────────────────────────────────────────────────

export interface GineeResponse<T = any> {
  code: string;
  msg: string;
  data: T;
  requestId: string;
}

// ─── Webhook Payload Types ────────────────────────────────────────────────────

export type GineeWebhookEventType =
  | 'stock_updated'
  | 'inventory_updated'
  | 'master_product_updated'
  | 'product_updated'
  | 'order_created'
  | 'order_updated'
  | 'order_cancelled';

export interface GineeWebhookBase {
  eventType: GineeWebhookEventType;
  eventId: string;       // Use this for idempotency checks
  shopId: string;
  timestamp: number;
}

export interface GineeStockWebhookPayload extends GineeWebhookBase {
  eventType: 'stock_updated' | 'inventory_updated';
  data: {
    sku: string;
    availableStock: number;
    warehouseStock: number;
  };
}

export interface GineeProductWebhookPayload extends GineeWebhookBase {
  eventType: 'master_product_updated' | 'product_updated';
  data: {
    productId: string;
    masterSku?: string;
    productName: string;
  };
}

export interface GineeOrderWebhookPayload extends GineeWebhookBase {
  eventType: 'order_created' | 'order_updated' | 'order_cancelled';
  data: {
    orderId: string;
    orderStatus: 'UNPAID' | 'PAID' | 'READY_TO_SHIP' | 'SHIPPED' | 'DELIVERED' | 'COMPLETED' | 'CANCELLED';
    items: Array<{
      sku: string;
      quantity: number;
    }>;
  };
}

export type GineeWebhookPayload =
  | GineeStockWebhookPayload
  | GineeProductWebhookPayload
  | GineeOrderWebhookPayload;

// ─── Sync Result ──────────────────────────────────────────────────────────────

export interface SyncResult {
  status: 'SUCCESS' | 'SKIPPED' | 'FAILED';
  productId: string;
  message?: string;
}

export interface SyncAllResult {
  sessionId: string;
  totalFetched: number;
  success: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
}
