import type { UUID } from "../../types/business";

import type {
  OfflineOrder,
  OfflineOrderSyncResponse,
  SyncError,
} from "../../types/offline";

import {
  createOfflineOrderSyncRequest,
} from "../../types/offline";

import {
  ApiError,
  getAccessToken,
  isApiError,
  isNetworkError,
} from "../api/client";

import {
  getCurrentUser,
} from "../api/authApi";

import {
  synchronizeOfflineOrder,
} from "../api/salesApi";

import {
  getOfflineOrder,
  getOfflineOrderCounts,
  getPendingSyncOrders,
  markOrderSynced,
  markOrderSyncing,
  recoverInterruptedSyncs,
  saveSyncFailure,
} from "../local-storage/offlineDb";

/**
 * Synchronizes locally submitted sales orders with the backend.
 *
 * IndexedDB retains the original order and idempotency key across
 * retries. Backend confirmation is required before recording success.
 * Business approval remains independent of synchronization status.
 */

export const SYNC_RETRY_CONFIG = {
  INITIAL_DELAY_MS: 5_000,
  MAX_DELAY_MS: 300_000,
  MAX_AUTO_RETRIES: 5,
  REQUEST_TIMEOUT_MS: 30_000,
} as const;

export type SyncTrigger =
  | "manual"
  | "online"
  | "startup"
  | "retry";

export type SyncOutcome =
  | "synced"
  | "failed"
  | "conflict"
  | "skipped";

export interface SyncOrderOutcome {
  localId: UUID;
  outcome: SyncOutcome;
  serverOrderId: UUID | null;
  serverOrderNumber: string | null;
  message: string;
  retryable: boolean;
  nextRetryAt: string | null;
}

export interface SyncBatchOutcome {
  salesmanId: UUID;
  trigger: SyncTrigger;
  startedAt: string;
  completedAt: string;
  attempted: number;
  synced: number;
  failed: number;
  conflicts: number;
  skipped: number;
  results: SyncOrderOutcome[];
}

export interface SyncServiceState {
  salesmanId: UUID | null;
  isSyncing: boolean;
  isOnline: boolean;
  backendReachable: boolean | null;
  currentOrderId: UUID | null;
  completed: number;
  total: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface SyncProgressEvent {
  salesmanId: UUID;
  completed: number;
  total: number;
  currentOrderId: UUID | null;
  result: SyncOrderOutcome | null;
}

export interface SyncBatchOptions {
  trigger?: SyncTrigger;
  forceRetry?: boolean;
  signal?: AbortSignal;
  onProgress?: (
    progress: SyncProgressEvent,
  ) => void;
}

export interface SyncSingleOrderOptions {
  forceRetry?: boolean;
  signal?: AbortSignal;
}

export type SyncStateListener = (
  state: Readonly<SyncServiceState>,
) => void;

interface BackendSyncConfirmation {
  accepted: boolean;
  orderId: UUID | null;
  orderNumber: string | null;
  message: string | null;
}

interface ClassifiedSyncError {
  message: string;
  code: string;
  retryable: boolean;
  conflict: boolean;
}

const activeOrderSyncs = new Map<
  string,
  Promise<SyncOrderOutcome>
>();

const activeBatchSyncs = new Map<
  UUID,
  Promise<SyncBatchOutcome>
>();

const stateListeners = new Set<
  SyncStateListener
>();

let syncState: SyncServiceState = {
  salesmanId: null,
  isSyncing: false,
  isOnline:
    typeof navigator !== "undefined"
      ? navigator.onLine
      : false,
  backendReachable: null,
  currentOrderId: null,
  completed: 0,
  total: 0,
  lastSyncAt: null,
  lastError: null,
};

function requireIdentifier(
  value: string,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error(
      `${label} is required.`,
    );
  }

  return value.trim();
}

function getOrderLockKey(
  salesmanId: UUID,
  localId: UUID,
): string {
  return JSON.stringify([
    salesmanId,
    localId,
  ]);
}

function getCurrentOnlineStatus(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.onLine
  );
}

function updateState(
  changes: Partial<SyncServiceState>,
): void {
  syncState = {
    ...syncState,
    ...changes,
  };

  const snapshot = {
    ...syncState,
  };

  for (const listener of stateListeners) {
    try {
      listener(snapshot);
    } catch {
      // Listener failures must not interrupt synchronization.
    }
  }
}

export function getSyncServiceState(): SyncServiceState {
  return {
    ...syncState,
  };
}

export function subscribeToSyncState(
  listener: SyncStateListener,
): () => void {
  stateListeners.add(listener);

  listener(getSyncServiceState());

  return () => {
    stateListeners.delete(listener);
  };
}

function requireAuthentication(): void {
  if (!getAccessToken()) {
    throw new ApiError(
      "Authentication is required before synchronization.",
      {
        status: 401,
        category: "authentication",
        code: "AUTHENTICATION_REQUIRED",
      },
    );
  }
}

function assertNotAborted(
  signal?: AbortSignal,
): void {
  if (signal?.aborted) {
    throw new DOMException(
      "Synchronization was cancelled.",
      "AbortError",
    );
  }
}

function isAbortError(
  error: unknown,
): boolean {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

function getStringField(
  record: Record<string, unknown>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const value = record[name];

    if (
      typeof value === "string" &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  return null;
}

function getRecord(
  value: unknown,
): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseBackendConfirmation(
  response: OfflineOrderSyncResponse,
): BackendSyncConfirmation {
  const data = getRecord(response);

  if (!data) {
    throw new ApiError(
      "The backend returned an invalid synchronization response.",
      {
        category: "server",
        code: "INVALID_SYNC_RESPONSE",
      },
    );
  }

  const nestedOrder = getRecord(
    data.order,
  );

  const orderId =
    getStringField(data, [
      "server_order_id",
      "order_id",
      "sales_order_id",
    ]) ??
    (
      nestedOrder
        ? getStringField(
            nestedOrder,
            ["id", "order_id"],
          )
        : null
    );

  const orderNumber =
    getStringField(data, [
      "server_order_number",
      "order_number",
    ]) ??
    (
      nestedOrder
        ? getStringField(
            nestedOrder,
            ["order_number"],
          )
        : null
    );

  const status = getStringField(
    data,
    [
      "sync_status",
      "status",
    ],
  );

  const accepted =
    data.accepted === true ||
    data.success === true ||
    data.synced === true ||
    status === "synced" ||
    status === "accepted";

  return {
    accepted,
    orderId,
    orderNumber,
    message: getStringField(
      data,
      ["message", "detail"],
    ),
  };
}

function classifySyncError(
  error: unknown,
): ClassifiedSyncError {
  if (isAbortError(error)) {
    return {
      message:
        "Synchronization was interrupted. The order remains saved locally.",
      code: "SYNC_INTERRUPTED",
      retryable: true,
      conflict: false,
    };
  }

  if (isApiError(error)) {
    const isConflict =
      error.category === "conflict" ||
      error.category === "validation" ||
      error.status === 409 ||
      error.status === 422;

    const isAuthenticationFailure =
      error.category === "authentication" ||
      error.category === "authorization";

    return {
      message: error.message,
      code:
        error.code ??
        (
          isConflict
            ? "SYNC_CONFLICT"
            : "SYNC_REQUEST_FAILED"
        ),
      retryable:
        !isConflict &&
        !isAuthenticationFailure &&
        (
          error.retryable ||
          error.category === "network" ||
          error.category === "timeout"
        ),
      conflict: isConflict,
    };
  }

  if (isNetworkError(error)) {
    return {
      message:
        "The backend could not be reached. The order remains saved locally.",
      code: "NETWORK_ERROR",
      retryable: true,
      conflict: false,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      code: "SYNC_ERROR",
      retryable: false,
      conflict: false,
    };
  }

  return {
    message:
      "Synchronization failed. The order remains saved locally.",
    code: "UNKNOWN_SYNC_ERROR",
    retryable: false,
    conflict: false,
  };
}

function createStoredSyncError(
  error: ClassifiedSyncError,
): SyncError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  } as SyncError;
}

export function calculateSyncRetryDelay(
  attemptCount: number,
): number {
  const normalizedAttempts = Math.max(
    1,
    Math.floor(
      Number.isFinite(attemptCount)
        ? attemptCount
        : 1,
    ),
  );

  const exponent = Math.min(
    normalizedAttempts - 1,
    16,
  );

  return Math.min(
    SYNC_RETRY_CONFIG.MAX_DELAY_MS,
    SYNC_RETRY_CONFIG.INITIAL_DELAY_MS *
      2 ** exponent,
  );
}

function calculateNextRetryAt(
  attemptCount: number,
  retryable: boolean,
): string | null {
  if (
    !retryable ||
    attemptCount >=
      SYNC_RETRY_CONFIG.MAX_AUTO_RETRIES
  ) {
    return null;
  }

  return new Date(
    Date.now() +
      calculateSyncRetryDelay(
        attemptCount,
      ),
  ).toISOString();
}

function isRetryDue(
  order: OfflineOrder,
  forceRetry: boolean,
): boolean {
  if (forceRetry) {
    return true;
  }

  if (
    order.sync_status === "pending_sync"
  ) {
    return true;
  }

  if (
    order.sync_status !== "sync_failed"
  ) {
    return false;
  }

  if (
    order.sync_attempt_count >=
    SYNC_RETRY_CONFIG.MAX_AUTO_RETRIES
  ) {
    return false;
  }

  if (!order.next_retry_at) {
    return false;
  }

  const retryTime = Date.parse(
    order.next_retry_at,
  );

  return (
    Number.isFinite(retryTime) &&
    retryTime <= Date.now()
  );
}

function skippedOutcome(
  localId: UUID,
  message: string,
): SyncOrderOutcome {
  return {
    localId,
    outcome: "skipped",
    serverOrderId: null,
    serverOrderNumber: null,
    message,
    retryable: false,
    nextRetryAt: null,
  };
}

function ensureSalesmanAccess(
  salesmanId: UUID,
  currentUser: {
    id: UUID;
    role: string;
    is_active: boolean;
  },
): void {
  if (
    !currentUser.is_active ||
    currentUser.role !== "salesman" ||
    currentUser.id !== salesmanId
  ) {
    throw new ApiError(
      "Synchronization is restricted to the authenticated owner of these offline orders.",
      {
        status: 403,
        category: "authorization",
        code: "SYNC_ACCESS_DENIED",
      },
    );
  }
}

/* Backend connectivity */

export async function checkBackendConnectivity(
  salesmanId?: UUID,
  signal?: AbortSignal,
): Promise<boolean> {
  updateState({
    isOnline: getCurrentOnlineStatus(),
  });

  if (!getCurrentOnlineStatus()) {
    updateState({
      backendReachable: false,
    });

    return false;
  }

  assertNotAborted(signal);
  requireAuthentication();

  try {
    const user = await getCurrentUser({
      signal,
      timeoutMs:
        SYNC_RETRY_CONFIG.REQUEST_TIMEOUT_MS,
    });

    if (salesmanId) {
      ensureSalesmanAccess(
        salesmanId,
        user,
      );
    }

    updateState({
      backendReachable: true,
    });

    return true;
  } catch (error) {
    if (
      isApiError(error) &&
      (
        error.category === "authentication" ||
        error.category === "authorization"
      )
    ) {
      updateState({
        backendReachable: true,
        lastError: error.message,
      });

      throw error;
    }

    if (isAbortError(error)) {
      throw error;
    }

    updateState({
      backendReachable: false,
      lastError:
        error instanceof Error
          ? error.message
          : "Backend connectivity check failed.",
    });

    return false;
  }
}

/* Individual order synchronization */

async function performOrderSync(
  salesmanId: UUID,
  localId: UUID,
  options: SyncSingleOrderOptions,
): Promise<SyncOrderOutcome> {
  assertNotAborted(options.signal);
  requireAuthentication();

  const order = await getOfflineOrder(
    salesmanId,
    localId,
  );

  if (!order) {
    throw new Error(
      "The offline order was not found.",
    );
  }

  if (
    order.salesman_id !== salesmanId
  ) {
    throw new Error(
      "The offline order belongs to another Salesman.",
    );
  }

  if (order.sync_status === "synced") {
    return skippedOutcome(
      localId,
      "The order is already synchronized.",
    );
  }

  if (
    order.sync_status === "local_draft"
  ) {
    return skippedOutcome(
      localId,
      "The order must be submitted before synchronization.",
    );
  }

  if (order.sync_status === "conflict") {
    return skippedOutcome(
      localId,
      "The order requires conflict resolution before synchronization.",
    );
  }

  if (order.sync_status === "syncing") {
    return skippedOutcome(
      localId,
      "The order is already marked as synchronizing.",
    );
  }

  if (
    !isRetryDue(
      order,
      options.forceRetry ?? false,
    )
  ) {
    return skippedOutcome(
      localId,
      "The order is not yet eligible for another synchronization attempt.",
    );
  }

  const reachable =
    await checkBackendConnectivity(
      salesmanId,
      options.signal,
    );

  if (!reachable) {
    return skippedOutcome(
      localId,
      "The backend is unavailable. The order remains saved locally.",
    );
  }

  assertNotAborted(options.signal);

  const syncingOrder =
    await markOrderSyncing(
      salesmanId,
      localId,
    );

  try {
    const request =
      createOfflineOrderSyncRequest(
        syncingOrder,
      );

    const response =
      await synchronizeOfflineOrder(
        request,
        {
          signal: options.signal,
          timeoutMs:
            SYNC_RETRY_CONFIG.REQUEST_TIMEOUT_MS,
          idempotencyKey:
            syncingOrder.idempotency_key,
        },
      );

    const confirmation =
      parseBackendConfirmation(response);

    if (
      !confirmation.accepted ||
      !confirmation.orderId
    ) {
      throw new ApiError(
        confirmation.message ??
          "The backend did not confirm that the order was committed.",
        {
          category: "server",
          code: "SYNC_NOT_CONFIRMED",
          retryable: true,
        },
      );
    }

    await markOrderSynced(
      salesmanId,
      localId,
      confirmation.orderId,
      confirmation.orderNumber,
    );

    return {
      localId,
      outcome: "synced",
      serverOrderId:
        confirmation.orderId,
      serverOrderNumber:
        confirmation.orderNumber,
      message:
        confirmation.message ??
        "The backend confirmed successful synchronization.",
      retryable: false,
      nextRetryAt: null,
    };
  } catch (error) {
    const classified =
      classifySyncError(error);

    const nextRetryAt =
      calculateNextRetryAt(
        syncingOrder.sync_attempt_count,
        classified.retryable,
      );

    await saveSyncFailure(
      salesmanId,
      localId,
      createStoredSyncError(
        classified,
      ),
      nextRetryAt,
      classified.conflict,
    );

    return {
      localId,
      outcome: classified.conflict
        ? "conflict"
        : "failed",
      serverOrderId: null,
      serverOrderNumber: null,
      message: classified.message,
      retryable:
        classified.retryable,
      nextRetryAt,
    };
  }
}

export async function syncOfflineOrder(
  salesmanId: UUID,
  localId: UUID,
  options: SyncSingleOrderOptions = {},
): Promise<SyncOrderOutcome> {
  requireIdentifier(
    salesmanId,
    "Salesman ID",
  );

  requireIdentifier(
    localId,
    "Local order ID",
  );

  const lockKey = getOrderLockKey(
    salesmanId,
    localId,
  );

  const active =
    activeOrderSyncs.get(lockKey);

  if (active) {
    return active;
  }

  const task = performOrderSync(
    salesmanId,
    localId,
    options,
  );

  activeOrderSyncs.set(
    lockKey,
    task,
  );

  try {
    return await task;
  } finally {
    if (
      activeOrderSyncs.get(lockKey) ===
      task
    ) {
      activeOrderSyncs.delete(
        lockKey,
      );
    }
  }
}

/* Batch synchronization */

async function performBatchSync(
  salesmanId: UUID,
  options: SyncBatchOptions,
): Promise<SyncBatchOutcome> {
  const trigger =
    options.trigger ?? "manual";

  const startedAt =
    new Date().toISOString();

  const results: SyncOrderOutcome[] = [];

  updateState({
    salesmanId,
    isSyncing: true,
    currentOrderId: null,
    completed: 0,
    total: 0,
    lastError: null,
    isOnline: getCurrentOnlineStatus(),
  });

  try {
    assertNotAborted(options.signal);
    requireAuthentication();

    const reachable =
      await checkBackendConnectivity(
        salesmanId,
        options.signal,
      );

    if (!reachable) {
      throw new ApiError(
        "The backend is unavailable. Pending orders remain saved locally.",
        {
          category: "network",
          code: "BACKEND_UNAVAILABLE",
          retryable: true,
        },
      );
    }

    const pendingOrders =
      await getPendingSyncOrders(
        salesmanId,
      );

    const eligibleOrders =
      pendingOrders.filter(
        (order) =>
          isRetryDue(
            order,
            options.forceRetry ?? false,
          ),
      );

    eligibleOrders.sort(
      (first, second) =>
        first.created_at.localeCompare(
          second.created_at,
        ),
    );

    updateState({
      total: eligibleOrders.length,
    });

    for (const order of eligibleOrders) {
      assertNotAborted(
        options.signal,
      );

      updateState({
        currentOrderId:
          order.local_id,
      });

      const result =
        await syncOfflineOrder(
          salesmanId,
          order.local_id,
          {
            forceRetry:
              options.forceRetry,
            signal: options.signal,
          },
        );

      results.push(result);

      updateState({
        completed: results.length,
        lastError:
          result.outcome === "failed" ||
          result.outcome === "conflict"
            ? result.message
            : syncState.lastError,
      });

      options.onProgress?.({
        salesmanId,
        completed: results.length,
        total:
          eligibleOrders.length,
        currentOrderId:
          order.local_id,
        result,
      });

      if (
        result.outcome === "failed" &&
        !getCurrentOnlineStatus()
      ) {
        break;
      }
    }

    return {
      salesmanId,
      trigger,
      startedAt,
      completedAt:
        new Date().toISOString(),
      attempted: results.filter(
        (result) =>
          result.outcome !== "skipped",
      ).length,
      synced: results.filter(
        (result) =>
          result.outcome === "synced",
      ).length,
      failed: results.filter(
        (result) =>
          result.outcome === "failed",
      ).length,
      conflicts: results.filter(
        (result) =>
          result.outcome === "conflict",
      ).length,
      skipped: results.filter(
        (result) =>
          result.outcome === "skipped",
      ).length,
      results,
    };
  } catch (error) {
    updateState({
      lastError:
        error instanceof Error
          ? error.message
          : "Synchronization failed.",
    });

    throw error;
  } finally {
    updateState({
      isSyncing: false,
      currentOrderId: null,
      lastSyncAt:
        new Date().toISOString(),
      isOnline:
        getCurrentOnlineStatus(),
    });
  }
}

export async function syncPendingOrders(
  salesmanId: UUID,
  options: SyncBatchOptions = {},
): Promise<SyncBatchOutcome> {
  requireIdentifier(
    salesmanId,
    "Salesman ID",
  );

  const existing =
    activeBatchSyncs.get(salesmanId);

  if (existing) {
    return existing;
  }

  const task = performBatchSync(
    salesmanId,
    options,
  );

  activeBatchSyncs.set(
    salesmanId,
    task,
  );

  try {
    return await task;
  } finally {
    if (
      activeBatchSyncs.get(
        salesmanId,
      ) === task
    ) {
      activeBatchSyncs.delete(
        salesmanId,
      );
    }
  }
}

/* Recovery and retry */

export async function recoverPendingSynchronization(
  salesmanId: UUID,
): Promise<number> {
  requireIdentifier(
    salesmanId,
    "Salesman ID",
  );

  return recoverInterruptedSyncs(
    salesmanId,
  );
}

export async function retryOfflineOrder(
  salesmanId: UUID,
  localId: UUID,
  signal?: AbortSignal,
): Promise<SyncOrderOutcome> {
  const order = await getOfflineOrder(
    salesmanId,
    localId,
  );

  if (!order) {
    throw new Error(
      "The offline order was not found.",
    );
  }

  if (
    order.sync_status !== "sync_failed"
  ) {
    return skippedOutcome(
      localId,
      "Only failed synchronization attempts can be retried.",
    );
  }

  return syncOfflineOrder(
    salesmanId,
    localId,
    {
      forceRetry: true,
      signal,
    },
  );
}

export async function getSynchronizationCounts(
  salesmanId: UUID,
) {
  return getOfflineOrderCounts(
    salesmanId,
  );
}

export function isSynchronizationActive(
  salesmanId?: UUID,
): boolean {
  if (salesmanId) {
    return activeBatchSyncs.has(
      salesmanId,
    );
  }

  return (
    activeBatchSyncs.size > 0 ||
    activeOrderSyncs.size > 0
  );
}

/* Browser connectivity integration */

export interface AutomaticSyncController {
  start: () => void;
  stop: () => void;
  syncNow: () => Promise<SyncBatchOutcome>;
}

export function createAutomaticSyncController(
  salesmanId: UUID,
  onError?: (error: unknown) => void,
): AutomaticSyncController {
  requireIdentifier(
    salesmanId,
    "Salesman ID",
  );

  let started = false;
  let stopped = false;

  const handleOnline = (): void => {
    updateState({
      isOnline: true,
    });

    if (
      !started ||
      stopped ||
      !getAccessToken()
    ) {
      return;
    }

    void syncPendingOrders(
      salesmanId,
      {
        trigger: "online",
      },
    ).catch((error: unknown) => {
      onError?.(error);
    });
  };

  const handleOffline = (): void => {
    updateState({
      isOnline: false,
      backendReachable: false,
    });
  };

  return {
    start() {
      if (
        started ||
        typeof window === "undefined"
      ) {
        return;
      }

      started = true;
      stopped = false;

      window.addEventListener(
        "online",
        handleOnline,
      );

      window.addEventListener(
        "offline",
        handleOffline,
      );

      updateState({
        isOnline:
          getCurrentOnlineStatus(),
      });
    },

    stop() {
      if (
        !started ||
        typeof window === "undefined"
      ) {
        return;
      }

      stopped = true;
      started = false;

      window.removeEventListener(
        "online",
        handleOnline,
      );

      window.removeEventListener(
        "offline",
        handleOffline,
      );
    },

    syncNow() {
      return syncPendingOrders(
        salesmanId,
        {
          trigger: "manual",
          forceRetry: true,
        },
      );
    },
  };
}

export const syncService = {
  getSyncServiceState,
  subscribeToSyncState,

  calculateSyncRetryDelay,
  checkBackendConnectivity,

  syncOfflineOrder,
  syncPendingOrders,
  retryOfflineOrder,

  recoverPendingSynchronization,
  getSynchronizationCounts,
  isSynchronizationActive,

  createAutomaticSyncController,
} as const;