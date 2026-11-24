import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
} from "idb";

import type { UUID } from "../../types/business";

import type {
  CachedCustomer,
  CachedOrderHistory,
  CachedPrice,
  CachedProduct,
  OfflineCacheMetadata,
  OfflineOrder,
  OfflineOrderInput,
  OfflineOrderUpdate,
  OfflineSyncStatus,
  SyncQueueEntry,
} from "../../types/offline";

import {
  isOfflineOrderEditable,
  isOfflineOrderUnsynchronized,
} from "../../types/offline";

/**
 * IndexedDB persistence for offline Salesman operations.
 *
 * Local records are isolated by Salesman ID. Unsynchronized orders
 * are retained until explicitly resolved, and server acceptance
 * must be confirmed before an order is marked as synchronized.
 */

export const OFFLINE_DB_NAME =
  "fmms-salesman-offline";

export const OFFLINE_DB_VERSION = 1;

export const OFFLINE_DB_STORES = {
  ORDERS: "orders",
  SYNC_QUEUE: "sync_queue",
  CUSTOMERS: "customers",
  PRODUCTS: "products",
  PRICES: "prices",
  ORDER_HISTORY: "order_history",
  CACHE_METADATA: "cache_metadata",
} as const;

interface OwnedRecord<T> {
  key: string;
  salesman_id: UUID;
  value: T;
}

interface StoredOrder extends OwnedRecord<OfflineOrder> {
  local_id: UUID;
  sync_status: OfflineSyncStatus;
  updated_at: string;
}

interface StoredQueueEntry
  extends OwnedRecord<SyncQueueEntry> {
  local_id: UUID;
}

interface OfflineDatabase extends DBSchema {
  orders: {
    key: string;
    value: StoredOrder;
    indexes: {
      by_salesman: string;
      by_salesman_status: [
        string,
        OfflineSyncStatus,
      ];
    };
  };

  sync_queue: {
    key: string;
    value: StoredQueueEntry;
    indexes: {
      by_salesman: string;
    };
  };

  customers: {
    key: string;
    value: OwnedRecord<CachedCustomer>;
    indexes: {
      by_salesman: string;
    };
  };

  products: {
    key: string;
    value: OwnedRecord<CachedProduct>;
    indexes: {
      by_salesman: string;
    };
  };

  prices: {
    key: string;
    value: OwnedRecord<CachedPrice>;
    indexes: {
      by_salesman: string;
    };
  };

  order_history: {
    key: string;
    value: OwnedRecord<CachedOrderHistory>;
    indexes: {
      by_salesman: string;
    };
  };

  cache_metadata: {
    key: string;
    value: OwnedRecord<OfflineCacheMetadata>;
    indexes: {
      by_salesman: string;
    };
  };
}

export interface OfflineOrderFilters {
  statuses?: readonly OfflineSyncStatus[];
  includeSynced?: boolean;
}

export interface OfflineOrderCounts {
  total: number;
  local_draft: number;
  pending_sync: number;
  syncing: number;
  synced: number;
  sync_failed: number;
  conflict: number;
}

export interface OfflineCacheSnapshot {
  customers: CachedCustomer[];
  products: CachedProduct[];
  prices: CachedPrice[];
  metadata: OfflineCacheMetadata | null;
}

export interface SaveOfflineCacheInput {
  customers: CachedCustomer[];
  products: CachedProduct[];
  prices: CachedPrice[];
  metadata: OfflineCacheMetadata;
}

type CacheStoreName =
  | "customers"
  | "products"
  | "prices"
  | "order_history"
  | "cache_metadata";

let databasePromise:
  | Promise<IDBPDatabase<OfflineDatabase>>
  | null = null;

function requireIdentifier(
  value: string,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error(`${label} is required.`);
  }

  return value.trim();
}

function ownerKey(
  salesmanId: UUID,
  recordId: string,
): string {
  return `${requireIdentifier(
    salesmanId,
    "Salesman ID",
  )}:${requireIdentifier(
    recordId,
    "Record ID",
  )}`;
}

function getRecordIdentifier(
  record: object,
  candidates: readonly string[],
): string {
  const fields = record as Record<
    string,
    unknown
  >;

  for (const field of candidates) {
    const value = fields[field];

    if (
      typeof value === "string" &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  throw new Error(
    "The cached record does not contain a valid identifier.",
  );
}

function createOwnedRecord<T>(
  salesmanId: UUID,
  recordId: string,
  value: T,
): OwnedRecord<T> {
  return {
    key: ownerKey(salesmanId, recordId),
    salesman_id: salesmanId,
    value,
  };
}

function createStoredOrder(
  order: OfflineOrder,
): StoredOrder {
  return {
    ...createOwnedRecord(
      order.salesman_id,
      order.local_id,
      order,
    ),
    local_id: order.local_id,
    sync_status: order.sync_status,
    updated_at: order.updated_at,
  };
}

function createStoredQueueEntry(
  salesmanId: UUID,
  localId: UUID,
  entry: SyncQueueEntry,
): StoredQueueEntry {
  return {
    ...createOwnedRecord(
      salesmanId,
      localId,
      entry,
    ),
    local_id: localId,
  };
}

function validateOrderOwnership(
  salesmanId: UUID,
  order: OfflineOrder,
): void {
  requireIdentifier(
    salesmanId,
    "Salesman ID",
  );

  requireIdentifier(
    order.local_id,
    "Local order ID",
  );

  requireIdentifier(
    order.idempotency_key,
    "Idempotency key",
  );

  if (order.salesman_id !== salesmanId) {
    throw new Error(
      "The offline order belongs to another Salesman.",
    );
  }
}

function validateOrderIdentity(
  previous: OfflineOrder,
  next: OfflineOrder,
): void {
  if (
    previous.local_id !== next.local_id ||
    previous.salesman_id !== next.salesman_id ||
    previous.idempotency_key !==
      next.idempotency_key
  ) {
    throw new Error(
      "An existing offline order identity cannot be changed.",
    );
  }
}

function validateOrderTransition(
  previous: OfflineOrder,
  next: OfflineOrder,
): void {
  if (
    previous.sync_status === "synced" &&
    next.sync_status !== "synced"
  ) {
    throw new Error(
      "A synchronized order cannot return to an unsynchronized state.",
    );
  }

  if (
    previous.sync_status === "synced" &&
    JSON.stringify(previous) !==
      JSON.stringify(next)
  ) {
    throw new Error(
      "Synchronized orders cannot be modified locally.",
    );
  }

  if (
    next.sync_status === "synced" &&
    (
      !next.server_order_id ||
      !next.synced_at
    )
  ) {
    throw new Error(
      "Backend confirmation is required before marking an order as synchronized.",
    );
  }

  if (
    previous.sync_status !== "synced" &&
    next.sync_status === "synced" &&
    previous.sync_status !== "syncing"
  ) {
    throw new Error(
      "An order must be in the syncing state before synchronization can be confirmed.",
    );
  }
}

function validateNewOrder(
  order: OfflineOrder,
): void {
  if (order.sync_status === "synced") {
    throw new Error(
      "A new local order cannot be created as synchronized.",
    );
  }

  if (
    order.sync_status === "syncing" ||
    order.sync_status === "sync_failed" ||
    order.sync_status === "conflict"
  ) {
    throw new Error(
      "A new local order must begin as a draft or pending synchronization.",
    );
  }
}

function validateEditableOrder(
  order: OfflineOrder,
): void {
  if (!isOfflineOrderEditable(order.sync_status)) {
    throw new Error(
      "This offline order cannot be edited in its current synchronization state.",
    );
  }
}

function ensureValidDate(
  value: string,
): void {
  if (
    !value ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(
      "A valid order date is required.",
    );
  }
}

function validateOrderInput(
  input: OfflineOrderInput,
): void {
  requireIdentifier(
    input.customer_id,
    "Customer ID",
  );

  if (
    !Array.isArray(input.items) ||
    input.items.length === 0
  ) {
    throw new Error(
      "An offline order must contain at least one product.",
    );
  }

  for (const item of input.items) {
    requireIdentifier(
      item.product_id,
      "Product ID",
    );

    if (
      !/^\d+(?:\.\d+)?$/.test(
        item.quantity,
      ) ||
      !/[1-9]/.test(item.quantity)
    ) {
      throw new Error(
        "Each offline order quantity must be positive.",
      );
    }

    if (
      !/^\d+(?:\.\d+)?$/.test(
        item.captured_unit_price,
      )
    ) {
      throw new Error(
        "Each offline order price must be a non-negative decimal value.",
      );
    }
  }
}

export function isOfflineStorageSupported(): boolean {
  return (
    typeof indexedDB !== "undefined" &&
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  );
}

export async function getOfflineDatabase(): Promise<
  IDBPDatabase<OfflineDatabase>
> {
  if (!isOfflineStorageSupported()) {
    throw new Error(
      "IndexedDB or secure UUID generation is unavailable in this browser.",
    );
  }

  if (!databasePromise) {
    databasePromise = openDB<OfflineDatabase>(
      OFFLINE_DB_NAME,
      OFFLINE_DB_VERSION,
      {
        upgrade(database) {
          const orders = database.createObjectStore(
            OFFLINE_DB_STORES.ORDERS,
            {
              keyPath: "key",
            },
          );

          orders.createIndex(
            "by_salesman",
            "salesman_id",
          );

          orders.createIndex(
            "by_salesman_status",
            [
              "salesman_id",
              "sync_status",
            ],
          );

          const queue = database.createObjectStore(
            OFFLINE_DB_STORES.SYNC_QUEUE,
            {
              keyPath: "key",
            },
          );

          queue.createIndex(
            "by_salesman",
            "salesman_id",
          );

          const cacheStores = [
            OFFLINE_DB_STORES.CUSTOMERS,
            OFFLINE_DB_STORES.PRODUCTS,
            OFFLINE_DB_STORES.PRICES,
            OFFLINE_DB_STORES.ORDER_HISTORY,
            OFFLINE_DB_STORES.CACHE_METADATA,
          ] as const;

          for (const storeName of cacheStores) {
            const store =
              database.createObjectStore(
                storeName,
                {
                  keyPath: "key",
                },
              );

            store.createIndex(
              "by_salesman",
              "salesman_id",
            );
          }
        },
        blocked() {
          console.warn(
            "Offline database upgrade is blocked by another open application instance.",
          );
        },
        blocking() {
          databasePromise = null;
        },
        terminated() {
          databasePromise = null;
        },
      },
    ).catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });
  }

  return databasePromise;
}

export async function closeOfflineDatabase(): Promise<void> {
  if (!databasePromise) {
    return;
  }

  const database = await databasePromise;
  database.close();
  databasePromise = null;
}

/* Offline order creation and persistence */

export async function createOfflineOrder(
  salesmanId: UUID,
  input: OfflineOrderInput,
  submitForSync = false,
): Promise<OfflineOrder> {
  requireIdentifier(
    salesmanId,
    "Salesman ID",
  );

  validateOrderInput(input);

  const now = new Date().toISOString();
  const localId = crypto.randomUUID();

  const order: OfflineOrder = {
    ...input,
    items: input.items.map((item) => ({
      ...item,
      id: crypto.randomUUID(),
    })),
    local_id: localId,
    idempotency_key: crypto.randomUUID(),
    salesman_id: salesmanId,
    sync_status: submitForSync
      ? "pending_sync"
      : "local_draft",
    server_order_id: null,
    server_order_number: null,
    created_at: now,
    updated_at: now,
    submitted_at: submitForSync
      ? now
      : null,
    last_sync_attempt_at: null,
    synced_at: null,
    sync_attempt_count: 0,
    next_retry_at: null,
    sync_error: null,
  } as OfflineOrder;

  await saveOfflineOrder(
    salesmanId,
    order,
  );

  return order;
}

export async function saveOfflineOrder(
  salesmanId: UUID,
  order: OfflineOrder,
): Promise<void> {
  validateOrderOwnership(
    salesmanId,
    order,
  );

  ensureValidDate(order.order_date);

  const database = await getOfflineDatabase();

  const transaction = database.transaction(
    [
      OFFLINE_DB_STORES.ORDERS,
      OFFLINE_DB_STORES.SYNC_QUEUE,
    ],
    "readwrite",
  );

  const orders = transaction.objectStore(
    OFFLINE_DB_STORES.ORDERS,
  );

  const queue = transaction.objectStore(
    OFFLINE_DB_STORES.SYNC_QUEUE,
  );

  const key = ownerKey(
    salesmanId,
    order.local_id,
  );

  const existing = await orders.get(key);

  if (existing) {
    validateOrderIdentity(
      existing.value,
      order,
    );

    validateOrderTransition(
      existing.value,
      order,
    );
  } else {
    validateNewOrder(order);
  }

  await orders.put(
    createStoredOrder(order),
  );

  if (
    order.sync_status === "local_draft" ||
    order.sync_status === "synced" ||
    order.sync_status === "conflict"
  ) {
    await queue.delete(key);
  }

  await transaction.done;
}

export async function getOfflineOrder(
  salesmanId: UUID,
  localId: UUID,
): Promise<OfflineOrder | null> {
  const database = await getOfflineDatabase();

  const record = await database.get(
    OFFLINE_DB_STORES.ORDERS,
    ownerKey(salesmanId, localId),
  );

  return record?.value ?? null;
}

export async function getOfflineOrders(
  salesmanId: UUID,
  filters: OfflineOrderFilters = {},
): Promise<OfflineOrder[]> {
  const database = await getOfflineDatabase();

  const records = await database.getAllFromIndex(
    OFFLINE_DB_STORES.ORDERS,
    "by_salesman",
    requireIdentifier(
      salesmanId,
      "Salesman ID",
    ),
  );

  return records
    .map((record) => record.value)
    .filter((order) => {
      if (
        filters.includeSynced === false &&
        order.sync_status === "synced"
      ) {
        return false;
      }

      if (
        filters.statuses &&
        !filters.statuses.includes(
          order.sync_status,
        )
      ) {
        return false;
      }

      return true;
    })
    .sort((first, second) =>
      second.created_at.localeCompare(
        first.created_at,
      ),
    );
}

export async function getUnsynchronizedOrders(
  salesmanId: UUID,
): Promise<OfflineOrder[]> {
  const orders = await getOfflineOrders(
    salesmanId,
  );

  return orders.filter((order) =>
    isOfflineOrderUnsynchronized(order.sync_status),
  );
}

export async function getPendingSyncOrders(
  salesmanId: UUID,
): Promise<OfflineOrder[]> {
  return getOfflineOrders(salesmanId, {
    statuses: [
      "pending_sync",
      "sync_failed",
    ],
  });
}

export async function getOfflineOrderCounts(
  salesmanId: UUID,
): Promise<OfflineOrderCounts> {
  const orders = await getOfflineOrders(
    salesmanId,
  );

  const counts: OfflineOrderCounts = {
    total: orders.length,
    local_draft: 0,
    pending_sync: 0,
    syncing: 0,
    synced: 0,
    sync_failed: 0,
    conflict: 0,
  };

  for (const order of orders) {
    counts[order.sync_status] += 1;
  }

  return counts;
}

export async function updateOfflineOrder(
  salesmanId: UUID,
  localId: UUID,
  changes: OfflineOrderUpdate,
): Promise<OfflineOrder> {
  const existing = await getOfflineOrder(
    salesmanId,
    localId,
  );

  if (!existing) {
    throw new Error(
      "The offline order was not found.",
    );
  }

  validateEditableOrder(existing);

  const updated: OfflineOrder = {
    ...existing,
    ...changes,
    items: changes.items?.map((item) => ({
      ...item,
      id: crypto.randomUUID(),
    })) ?? existing.items,
    local_id: existing.local_id,
    idempotency_key:
      existing.idempotency_key,
    salesman_id: existing.salesman_id,
    sync_status: existing.sync_status,
    updated_at: new Date().toISOString(),
  };

  validateOrderInput(updated);

  await saveOfflineOrder(
    salesmanId,
    updated,
  );

  return updated;
}

export async function submitOfflineOrder(
  salesmanId: UUID,
  localId: UUID,
): Promise<OfflineOrder> {
  const existing = await getOfflineOrder(
    salesmanId,
    localId,
  );

  if (!existing) {
    throw new Error(
      "The offline order was not found.",
    );
  }

  if (
    existing.sync_status !== "local_draft"
  ) {
    throw new Error(
      "Only local drafts can be submitted for synchronization.",
    );
  }

  validateOrderInput(existing);

  const now = new Date().toISOString();

  const updated: OfflineOrder = {
    ...existing,
    sync_status: "pending_sync",
    submitted_at: now,
    updated_at: now,
    sync_error: null,
    next_retry_at: null,
  };

  await saveOfflineOrder(
    salesmanId,
    updated,
  );

  return updated;
}

export async function returnOfflineOrderToDraft(
  salesmanId: UUID,
  localId: UUID,
): Promise<OfflineOrder> {
  const existing = await getOfflineOrder(
    salesmanId,
    localId,
  );

  if (!existing) {
    throw new Error(
      "The offline order was not found.",
    );
  }

  if (
    existing.sync_status !== "pending_sync" ||
    existing.last_sync_attempt_at !== null
  ) {
    throw new Error(
      "Only pending orders that have never been synchronized can return to draft.",
    );
  }

  const updated: OfflineOrder = {
    ...existing,
    sync_status: "local_draft",
    submitted_at: null,
    updated_at: new Date().toISOString(),
    sync_error: null,
    next_retry_at: null,
  };

  await saveOfflineOrder(
    salesmanId,
    updated,
  );

  return updated;
}

/* Synchronization state persistence */

export async function markOrderSyncing(
  salesmanId: UUID,
  localId: UUID,
): Promise<OfflineOrder> {
  const existing = await getOfflineOrder(
    salesmanId,
    localId,
  );

  if (!existing) {
    throw new Error(
      "The offline order was not found.",
    );
  }

  if (
    existing.sync_status !== "pending_sync" &&
    existing.sync_status !== "sync_failed"
  ) {
    throw new Error(
      "The offline order is not eligible for synchronization.",
    );
  }

  const now = new Date().toISOString();

  const updated: OfflineOrder = {
    ...existing,
    sync_status: "syncing",
    last_sync_attempt_at: now,
    sync_attempt_count:
      existing.sync_attempt_count + 1,
    next_retry_at: null,
    sync_error: null,
    updated_at: now,
  };

  await saveOfflineOrder(
    salesmanId,
    updated,
  );

  return updated;
}

export async function markOrderSynced(
  salesmanId: UUID,
  localId: UUID,
  serverOrderId: UUID,
  serverOrderNumber: string | null = null,
): Promise<OfflineOrder> {
  requireIdentifier(
    serverOrderId,
    "Server order ID",
  );

  const existing = await getOfflineOrder(
    salesmanId,
    localId,
  );

  if (!existing) {
    throw new Error(
      "The offline order was not found.",
    );
  }

  if (
    existing.sync_status !== "syncing"
  ) {
    throw new Error(
      "The order must be synchronizing before backend acceptance can be recorded.",
    );
  }

  const now = new Date().toISOString();

  const updated: OfflineOrder = {
    ...existing,
    sync_status: "synced",
    server_order_id: serverOrderId,
    server_order_number:
      serverOrderNumber,
    synced_at: now,
    updated_at: now,
    next_retry_at: null,
    sync_error: null,
  };

  await saveOfflineOrder(
    salesmanId,
    updated,
  );

  return updated;
}

export async function saveSyncFailure(
  salesmanId: UUID,
  localId: UUID,
  syncError: OfflineOrder["sync_error"],
  nextRetryAt: string | null = null,
  conflict = false,
): Promise<OfflineOrder> {
  const existing = await getOfflineOrder(
    salesmanId,
    localId,
  );

  if (!existing) {
    throw new Error(
      "The offline order was not found.",
    );
  }

  if (
    existing.sync_status !== "syncing"
  ) {
    throw new Error(
      "Only an active synchronization attempt can be marked as failed.",
    );
  }

  const updated: OfflineOrder = {
    ...existing,
    sync_status: conflict
      ? "conflict"
      : "sync_failed",
    sync_error: syncError,
    next_retry_at: conflict
      ? null
      : nextRetryAt,
    updated_at: new Date().toISOString(),
  };

  await saveOfflineOrder(
    salesmanId,
    updated,
  );

  return updated;
}

export async function recoverInterruptedSyncs(
  salesmanId: UUID,
): Promise<number> {
  const database = await getOfflineDatabase();

  const transaction = database.transaction(
    OFFLINE_DB_STORES.ORDERS,
    "readwrite",
  );

  const store = transaction.objectStore(
    OFFLINE_DB_STORES.ORDERS,
  );

  const records = await store
    .index("by_salesman_status")
    .getAll([
      salesmanId,
      "syncing",
    ]);

  const now = new Date().toISOString();

  for (const record of records) {
    const updated: OfflineOrder = {
      ...record.value,
      sync_status: "sync_failed",
      updated_at: now,
      next_retry_at: null,
    };

    await (store as unknown as {
      put: (value: OwnedRecord<OfflineOrder>) => Promise<IDBValidKey>;
    }).put(
      createStoredOrder(updated),
    );
  }

  await transaction.done;

  return records.length;
}

/* Synchronization queue */

export async function saveSyncQueueEntry(
  salesmanId: UUID,
  localId: UUID,
  entry: SyncQueueEntry,
): Promise<void> {
  const database = await getOfflineDatabase();

  const transaction = database.transaction(
    [
      OFFLINE_DB_STORES.ORDERS,
      OFFLINE_DB_STORES.SYNC_QUEUE,
    ],
    "readwrite",
  );

  const key = ownerKey(
    salesmanId,
    localId,
  );

  const order = await transaction
    .objectStore(
      OFFLINE_DB_STORES.ORDERS,
    )
    .get(key);

  if (
    !order ||
    order.sync_status === "synced" ||
    order.sync_status === "local_draft" ||
    order.sync_status === "conflict"
  ) {
    throw new Error(
      "The order is not eligible for the synchronization queue.",
    );
  }

  await transaction
    .objectStore(
      OFFLINE_DB_STORES.SYNC_QUEUE,
    )
    .put(
      createStoredQueueEntry(
        salesmanId,
        localId,
        entry,
      ),
    );

  await transaction.done;
}

export async function getSyncQueueEntry(
  salesmanId: UUID,
  localId: UUID,
): Promise<SyncQueueEntry | null> {
  const database = await getOfflineDatabase();

  const record = await database.get(
    OFFLINE_DB_STORES.SYNC_QUEUE,
    ownerKey(salesmanId, localId),
  );

  return record?.value ?? null;
}

export async function getSyncQueue(
  salesmanId: UUID,
): Promise<SyncQueueEntry[]> {
  const database = await getOfflineDatabase();

  const records = await database.getAllFromIndex(
    OFFLINE_DB_STORES.SYNC_QUEUE,
    "by_salesman",
    requireIdentifier(
      salesmanId,
      "Salesman ID",
    ),
  );

  return records.map(
    (record) => record.value,
  );
}

export async function removeSyncQueueEntry(
  salesmanId: UUID,
  localId: UUID,
): Promise<void> {
  const database = await getOfflineDatabase();

  await database.delete(
    OFFLINE_DB_STORES.SYNC_QUEUE,
    ownerKey(salesmanId, localId),
  );
}

/* Cached master data */

async function getOwnedValues<T>(
  storeName: CacheStoreName,
  salesmanId: UUID,
): Promise<T[]> {
  const database = await getOfflineDatabase();

  const records = await database.getAllFromIndex(
    storeName,
    "by_salesman",
    requireIdentifier(
      salesmanId,
      "Salesman ID",
    ),
  );

  return records.map(
    (record) => record.value,
  ) as T[];
}

async function replaceOwnedRecords<T>(
  storeName:
    | "customers"
    | "products"
    | "prices"
    | "order_history",
  salesmanId: UUID,
  records: readonly T[],
  idFields: readonly string[],
): Promise<void> {
  const database = await getOfflineDatabase();

  const transaction = database.transaction(
    storeName,
    "readwrite",
  );

  const store = transaction.objectStore(
    storeName,
  );

  const existingKeys = await store
    .index("by_salesman")
    .getAllKeys(salesmanId);

  for (const key of existingKeys) {
    await store.delete(key);
  }

  for (const record of records) {
    const id = getRecordIdentifier(
      record as object,
      idFields,
    );

    await (store as unknown as {
      put: (value: OwnedRecord<T>) => Promise<IDBValidKey>;
    }).put(
      createOwnedRecord(
        salesmanId,
        id,
        record,
      ),
    );
  }

  await transaction.done;
}

export async function saveCachedCustomers(
  salesmanId: UUID,
  customers: readonly CachedCustomer[],
): Promise<void> {
  await replaceOwnedRecords(
    OFFLINE_DB_STORES.CUSTOMERS,
    salesmanId,
    customers,
    [
      "customer_id",
      "id",
    ],
  );
}

export async function getCachedCustomers(
  salesmanId: UUID,
): Promise<CachedCustomer[]> {
  return getOwnedValues<CachedCustomer>(
    OFFLINE_DB_STORES.CUSTOMERS,
    salesmanId,
  );
}

export async function saveCachedProducts(
  salesmanId: UUID,
  products: readonly CachedProduct[],
): Promise<void> {
  await replaceOwnedRecords(
    OFFLINE_DB_STORES.PRODUCTS,
    salesmanId,
    products,
    [
      "product_id",
      "id",
    ],
  );
}

export async function getCachedProducts(
  salesmanId: UUID,
): Promise<CachedProduct[]> {
  return getOwnedValues<CachedProduct>(
    OFFLINE_DB_STORES.PRODUCTS,
    salesmanId,
  );
}

export async function saveCachedPrices(
  salesmanId: UUID,
  prices: readonly CachedPrice[],
): Promise<void> {
  await replaceOwnedRecords(
    OFFLINE_DB_STORES.PRICES,
    salesmanId,
    prices,
    [
      "price_list_item_id",
      "id",
      "product_id",
    ],
  );
}

export async function getCachedPrices(
  salesmanId: UUID,
): Promise<CachedPrice[]> {
  return getOwnedValues<CachedPrice>(
    OFFLINE_DB_STORES.PRICES,
    salesmanId,
  );
}

export async function saveCachedOrderHistory(
  salesmanId: UUID,
  history: readonly CachedOrderHistory[],
): Promise<void> {
  await replaceOwnedRecords(
    OFFLINE_DB_STORES.ORDER_HISTORY,
    salesmanId,
    history,
    [
      "order_id",
      "id",
      "server_order_id",
    ],
  );
}

export async function getCachedOrderHistory(
  salesmanId: UUID,
): Promise<CachedOrderHistory[]> {
  return getOwnedValues<CachedOrderHistory>(
    OFFLINE_DB_STORES.ORDER_HISTORY,
    salesmanId,
  );
}

export async function saveOfflineCacheMetadata(
  salesmanId: UUID,
  metadata: OfflineCacheMetadata,
): Promise<void> {
  const database = await getOfflineDatabase();

  await database.put(
    OFFLINE_DB_STORES.CACHE_METADATA,
    createOwnedRecord(
      salesmanId,
      "metadata",
      metadata,
    ),
  );
}

export async function getOfflineCacheMetadata(
  salesmanId: UUID,
): Promise<OfflineCacheMetadata | null> {
  const database = await getOfflineDatabase();

  const record = await database.get(
    OFFLINE_DB_STORES.CACHE_METADATA,
    ownerKey(
      salesmanId,
      "metadata",
    ),
  );

  return record?.value ?? null;
}

export async function saveOfflineCache(
  salesmanId: UUID,
  input: SaveOfflineCacheInput,
): Promise<void> {
  requireIdentifier(
    salesmanId,
    "Salesman ID",
  );

  const database = await getOfflineDatabase();

  const transaction = database.transaction(
    [
      OFFLINE_DB_STORES.CUSTOMERS,
      OFFLINE_DB_STORES.PRODUCTS,
      OFFLINE_DB_STORES.PRICES,
      OFFLINE_DB_STORES.CACHE_METADATA,
    ],
    "readwrite",
  );

  const collections = [
    {
      store: OFFLINE_DB_STORES.CUSTOMERS,
      records: input.customers,
      idFields: [
        "customer_id",
        "id",
      ],
    },
    {
      store: OFFLINE_DB_STORES.PRODUCTS,
      records: input.products,
      idFields: [
        "product_id",
        "id",
      ],
    },
    {
      store: OFFLINE_DB_STORES.PRICES,
      records: input.prices,
      idFields: [
        "price_list_item_id",
        "id",
        "product_id",
      ],
    },
  ] as const;

  for (const collection of collections) {
    const store = transaction.objectStore(
      collection.store,
    );

    const keys = await store
      .index("by_salesman")
      .getAllKeys(salesmanId);

    for (const key of keys) {
      await store.delete(key);
    }

    for (const record of collection.records) {
      const id = getRecordIdentifier(
        record,
        collection.idFields,
      );

      await (store as unknown as {
        put: (value: OwnedRecord<unknown>) => Promise<IDBValidKey>;
      }).put(
        createOwnedRecord(
          salesmanId,
          id,
          record,
        ),
      );
    }
  }

  await transaction
    .objectStore(
      OFFLINE_DB_STORES.CACHE_METADATA,
    )
    .put(
      createOwnedRecord(
        salesmanId,
        "metadata",
        input.metadata,
      ),
    );

  await transaction.done;
}

export async function getOfflineCache(
  salesmanId: UUID,
): Promise<OfflineCacheSnapshot> {
  const [
    customers,
    products,
    prices,
    metadata,
  ] = await Promise.all([
    getCachedCustomers(salesmanId),
    getCachedProducts(salesmanId),
    getCachedPrices(salesmanId),
    getOfflineCacheMetadata(salesmanId),
  ]);

  return {
    customers,
    products,
    prices,
    metadata,
  };
}

/* Local data retention */

export async function deleteLocalDraft(
  salesmanId: UUID,
  localId: UUID,
): Promise<void> {
  const database = await getOfflineDatabase();

  const transaction = database.transaction(
    [
      OFFLINE_DB_STORES.ORDERS,
      OFFLINE_DB_STORES.SYNC_QUEUE,
    ],
    "readwrite",
  );

  const key = ownerKey(
    salesmanId,
    localId,
  );

  const order = await transaction
    .objectStore(
      OFFLINE_DB_STORES.ORDERS,
    )
    .get(key);

  if (!order) {
    throw new Error(
      "The offline order was not found.",
    );
  }

  if (
    order.sync_status !== "local_draft"
  ) {
    throw new Error(
      "Only local drafts may be deleted through this operation.",
    );
  }

  await transaction
    .objectStore(
      OFFLINE_DB_STORES.ORDERS,
    )
    .delete(key);

  await transaction
    .objectStore(
      OFFLINE_DB_STORES.SYNC_QUEUE,
    )
    .delete(key);

  await transaction.done;
}

export async function clearSalesmanReferenceCache(
  salesmanId: UUID,
): Promise<void> {
  const database = await getOfflineDatabase();

  const stores = [
    OFFLINE_DB_STORES.CUSTOMERS,
    OFFLINE_DB_STORES.PRODUCTS,
    OFFLINE_DB_STORES.PRICES,
    OFFLINE_DB_STORES.ORDER_HISTORY,
    OFFLINE_DB_STORES.CACHE_METADATA,
  ] as const;

  const transaction = database.transaction(
    stores,
    "readwrite",
  );

  for (const storeName of stores) {
    const store = transaction.objectStore(
      storeName,
    );

    const keys = await store
      .index("by_salesman")
      .getAllKeys(
        requireIdentifier(
          salesmanId,
          "Salesman ID",
        ),
      );

    for (const key of keys) {
      await store.delete(key);
    }
  }

  await transaction.done;
}

export const offlineDb = {
  isOfflineStorageSupported,
  getOfflineDatabase,
  closeOfflineDatabase,

  createOfflineOrder,
  saveOfflineOrder,
  getOfflineOrder,
  getOfflineOrders,
  getUnsynchronizedOrders,
  getPendingSyncOrders,
  getOfflineOrderCounts,
  updateOfflineOrder,
  submitOfflineOrder,
  returnOfflineOrderToDraft,

  markOrderSyncing,
  markOrderSynced,
  saveSyncFailure,
  recoverInterruptedSyncs,

  saveSyncQueueEntry,
  getSyncQueueEntry,
  getSyncQueue,
  removeSyncQueueEntry,

  saveCachedCustomers,
  getCachedCustomers,
  saveCachedProducts,
  getCachedProducts,
  saveCachedPrices,
  getCachedPrices,
  saveCachedOrderHistory,
  getCachedOrderHistory,
  saveOfflineCacheMetadata,
  getOfflineCacheMetadata,
  saveOfflineCache,
  getOfflineCache,

  deleteLocalDraft,
  clearSalesmanReferenceCache,
} as const;
