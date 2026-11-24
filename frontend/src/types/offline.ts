
import type {
  Customer,
  ISODateTime,
  Money,
  Product,
  Quantity,
  SalesOrder,
  SalesOrderInput,
  UUID,
  UnitOfMeasure,
} from "./business";

/**
 * Offline records are local application data, not authoritative
 * business transactions. Official orders exist only after backend acceptance.
 */

export const OFFLINE_SYNC_STATUSES = {
  LOCAL_DRAFT: "local_draft",
  PENDING_SYNC: "pending_sync",
  SYNCING: "syncing",
  SYNCED: "synced",
  SYNC_FAILED: "sync_failed",
  CONFLICT: "conflict",
} as const;

export type OfflineSyncStatus =
  (typeof OFFLINE_SYNC_STATUSES)[keyof typeof OFFLINE_SYNC_STATUSES];

export const OFFLINE_SYNC_STATUS_LABELS: Record<
  OfflineSyncStatus,
  string
> = {
  local_draft: "Local Draft",
  pending_sync: "Pending Sync",
  syncing: "Syncing",
  synced: "Synced",
  sync_failed: "Sync Failed",
  conflict: "Conflict",
};

export const SYNC_ERROR_CODES = {
  NETWORK_UNAVAILABLE: "network_unavailable",
  BACKEND_UNAVAILABLE: "backend_unavailable",
  AUTHENTICATION_REQUIRED: "authentication_required",
  PERMISSION_DENIED: "permission_denied",
  CUSTOMER_UNAVAILABLE: "customer_unavailable",
  CUSTOMER_NOT_ASSIGNED: "customer_not_assigned",
  PRODUCT_UNAVAILABLE: "product_unavailable",
  INVALID_QUANTITY: "invalid_quantity",
  INVALID_PRICE: "invalid_price",
  VALIDATION_FAILED: "validation_failed",
  IDEMPOTENCY_CONFLICT: "idempotency_conflict",
  SERVER_ERROR: "server_error",
  UNKNOWN: "unknown",
} as const;

export type SyncErrorCode =
  (typeof SYNC_ERROR_CODES)[keyof typeof SYNC_ERROR_CODES];

export type SyncErrorCategory =
  | "network"
  | "authentication"
  | "authorization"
  | "validation"
  | "conflict"
  | "server"
  | "unknown";

export interface SyncError {
  code: SyncErrorCode;
  category: SyncErrorCategory;
  message: string;
  retryable: boolean;
  occurred_at: ISODateTime;
  details?: Record<string, unknown> | null;
}

export interface OfflineOrderItem {
  id: UUID;
  product_id: UUID;
  product_name: string;
  quantity: Quantity;
  unit: UnitOfMeasure;
  captured_unit_price: Money;
}

export interface OfflineOrder {
  /**
   * Stable client-generated UUID, retained across synchronization retries.
   */
  local_id: UUID;

  /**
   * Stable idempotency key, never regenerated for an existing submission.
   */
  idempotency_key: UUID;

  salesman_id: UUID;
  customer_id: UUID;
  customer_name: string;

  order_date: ISODateTime;
  notes: string | null;
  items: OfflineOrderItem[];

  sync_status: OfflineSyncStatus;

  /**
   * Set only after the backend confirms successful order acceptance.
   */
  server_order_id: UUID | null;
  server_order_number: string | null;

  created_at: ISODateTime;
  updated_at: ISODateTime;

  submitted_at: ISODateTime | null;
  last_sync_attempt_at: ISODateTime | null;
  synced_at: ISODateTime | null;

  sync_attempt_count: number;
  next_retry_at: ISODateTime | null;
  sync_error: SyncError | null;
}

export interface OfflineOrderInput {
  customer_id: UUID;
  customer_name: string;
  order_date: ISODateTime;
  notes?: string | null;
  items: Array<{
    product_id: UUID;
    product_name: string;
    quantity: Quantity;
    unit: UnitOfMeasure;
    captured_unit_price: Money;
  }>;
}

export interface OfflineOrderUpdate {
  customer_id?: UUID;
  customer_name?: string;
  order_date?: ISODateTime;
  notes?: string | null;
  items?: OfflineOrderInput["items"];
}

export interface CachedCustomer {
  /**
   * Composite key identifying both the salesman and customer.
   */
  cache_key: string;
  salesman_id: UUID;
  customer_id: UUID;
  customer: Customer;
  cached_at: ISODateTime;
}

export interface CachedProduct {
  /**
   * Composite key identifying both the salesman and product.
   */
  cache_key: string;
  salesman_id: UUID;
  product_id: UUID;
  product: Product;
  cached_at: ISODateTime;
}

export interface CachedPrice {
  /**
   * Composite key identifying the salesman, customer, and product.
   */
  cache_key: string;
  salesman_id: UUID;
  customer_id: UUID;
  product_id: UUID;
  price_list_id: UUID | null;
  selling_price: Money;
  effective_from: string | null;
  effective_to: string | null;
  cached_at: ISODateTime;
}

export interface CachedOrderHistory {
  cache_key: string;
  salesman_id: UUID;
  server_order_id: UUID;
  order: SalesOrder;
  cached_at: ISODateTime;
}

export interface OfflineCacheMetadata {
  salesman_id: UUID;
  customers_updated_at: ISODateTime | null;
  products_updated_at: ISODateTime | null;
  prices_updated_at: ISODateTime | null;
  order_history_updated_at: ISODateTime | null;
}

export interface SyncQueueEntry {
  local_order_id: UUID;
  salesman_id: UUID;
  idempotency_key: UUID;
  enqueued_at: ISODateTime;
  attempt_count: number;
  last_attempt_at: ISODateTime | null;
  next_retry_at: ISODateTime | null;
}

export interface OfflineDatabaseSchema {
  orders: OfflineOrder;
  customers: CachedCustomer;
  products: CachedProduct;
  prices: CachedPrice;
  order_history: CachedOrderHistory;
  sync_queue: SyncQueueEntry;
  cache_metadata: OfflineCacheMetadata;
}

export interface OfflineOrderSyncRequest {
  local_order_id: UUID;
  idempotency_key: UUID;
  salesman_id: UUID;
  order: SalesOrderInput;
}

export interface OfflineOrderSyncResponse {
  local_order_id: UUID;
  server_order_id: UUID;
  server_order_number: string;
  accepted_at: ISODateTime;
  already_processed: boolean;
}

export interface SyncOrderResult {
  local_order_id: UUID;
  status: "synced" | "failed" | "conflict" | "skipped";
  server_order_id: UUID | null;
  error: SyncError | null;
}

export interface SyncBatchResult {
  started_at: ISODateTime;
  completed_at: ISODateTime;
  total: number;
  synced: number;
  failed: number;
  conflicts: number;
  skipped: number;
  results: SyncOrderResult[];
}

export interface SyncSummary {
  local_draft: number;
  pending_sync: number;
  syncing: number;
  synced: number;
  sync_failed: number;
  conflict: number;
  total: number;
}

export type BackendConnectivityStatus =
  | "unknown"
  | "checking"
  | "reachable"
  | "unreachable";

export interface ConnectivityState {
  is_online: boolean;
  backend_status: BackendConnectivityStatus;
  last_checked_at: ISODateTime | null;
}

export type SynchronizationState =
  | "idle"
  | "checking_connectivity"
  | "synchronizing"
  | "completed"
  | "failed";

export interface SyncProgress {
  state: SynchronizationState;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  conflicts: number;
  current_order_id: UUID | null;
  last_completed_at: ISODateTime | null;
  error: string | null;
}

export interface OfflineValidationIssue {
  field: string;
  message: string;
  item_id?: UUID;
}

export interface OfflineValidationResult {
  valid: boolean;
  issues: OfflineValidationIssue[];
}

export const EDITABLE_OFFLINE_STATUSES: readonly OfflineSyncStatus[] = [
  OFFLINE_SYNC_STATUSES.LOCAL_DRAFT,
];

export const RETRYABLE_OFFLINE_STATUSES: readonly OfflineSyncStatus[] = [
  OFFLINE_SYNC_STATUSES.PENDING_SYNC,
  OFFLINE_SYNC_STATUSES.SYNC_FAILED,
];

export function isOfflineOrderEditable(
  status: OfflineSyncStatus,
): boolean {
  return EDITABLE_OFFLINE_STATUSES.includes(status);
}

export function isOfflineOrderRetryable(
  status: OfflineSyncStatus,
): boolean {
  return RETRYABLE_OFFLINE_STATUSES.includes(status);
}

export function isOfflineOrderUnsynchronized(
  status: OfflineSyncStatus,
): boolean {
  return status !== OFFLINE_SYNC_STATUSES.SYNCED;
}

export function requiresOfflineOrderReview(
  status: OfflineSyncStatus,
): boolean {
  return status === OFFLINE_SYNC_STATUSES.CONFLICT;
}

export function createOfflineOrderSyncRequest(
  order: OfflineOrder,
): OfflineOrderSyncRequest {
  if (
    order.sync_status !== OFFLINE_SYNC_STATUSES.PENDING_SYNC &&
    order.sync_status !== OFFLINE_SYNC_STATUSES.SYNC_FAILED &&
    order.sync_status !== OFFLINE_SYNC_STATUSES.SYNCING
  ) {
    throw new Error(
      "Only submitted, unsynchronized orders can be sent for synchronization.",
    );
  }

  if (
    !order.local_id ||
    !order.idempotency_key ||
    !order.salesman_id ||
    !order.customer_id ||
    order.items.length === 0
  ) {
    throw new Error(
      "The offline order is missing required synchronization information.",
    );
  }

  return {
    local_order_id: order.local_id,
    idempotency_key: order.idempotency_key,
    salesman_id: order.salesman_id,
    order: {
      customer_id: order.customer_id,
      order_date: order.order_date,
      notes: order.notes,
      items: order.items.map((item) => ({
        product_id: item.product_id,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: item.captured_unit_price,
      })),
    },
  };
}
