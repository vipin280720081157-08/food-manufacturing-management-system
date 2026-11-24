import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  CloudUpload,
  Database,
  Edit3,
  Eye,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";

import { Link } from "react-router-dom";

import { USER_ROLES } from "../../types/auth";

import type {
  OfflineOrder,
  OfflineSyncStatus,
} from "../../types/offline";

import {
  isOfflineOrderEditable,
  isOfflineOrderRetryable,
} from "../../types/offline";

import { useAuth } from "../../hooks/useAuth";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";

import {
  getOfflineOrders,
  saveOfflineOrder,
  deleteLocalDraft as deleteOfflineOrder,
  getCachedCustomers,
  getCachedProducts,
  getCachedPrices,
} from "../../services/local-storage/offlineDb";

import {
  syncPendingOrders,
  syncOfflineOrder,
} from "../../services/synchronization/syncService";

import {
  getApiErrorMessage,
} from "../../services/api/client";

import {
  formatCurrency,
  formatDateTime,
  formatQuantity,
} from "../../utils/formatters";

import { LoadingState } from "../../components/common/LoadingState";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { OfflineStatusBadge } from "../../components/common/StatusBadge";

import SyncStatus, {
  type SyncStatusCounts,
  type SyncStatusOrder,
} from "./SyncStatus";

const MAX_ORDER_ITEMS = 100;
const MAX_NOTES_LENGTH = 2000;

type OrderFilter = "all" | OfflineSyncStatus;
type EditorMode = "create" | "edit";

interface CachedCustomerOption {
  id: string;
  name: string;
  customer_code?: string;
  is_active?: boolean;
}

interface CachedProductOption {
  id: string;
  name: string;
  item_code?: string;
  base_unit: string;
  is_active?: boolean;
}

interface CachedPriceOption {
  product_id: string;
  selling_price: string;
  customer_id?: string | null;
}

interface OrderLineForm {
  clientId: string;
  productId: string;
  quantity: string;
  unitPrice: string;
}

interface OrderEditorState {
  mode: EditorMode;
  localId: string | null;
  customerId: string;
  notes: string;
  lines: OrderLineForm[];
}

interface OrderRecord {
  localId: string;
  ownerId: string;
  customerId: string;
  customerName: string;
  notes: string;
  status: OfflineSyncStatus;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
  serverOrderId: string | null;
  errorMessage: string | null;
  items: Array<{
    productId: string;
    productName: string;
    quantity: string;
    unit: string;
    unitPrice: string;
  }>;
}

interface OfflineOrderStorage {
  local_id: string;
  salesman_id: string;
  customer_id: string;
  customer_name: string;
  notes: string | null;
  sync_status: OfflineSyncStatus;
  created_at: string;
  updated_at: string;
  idempotency_key: string;
  server_order_id: string | null;
  sync_error: null;
  items: Array<{
    id: string;
    product_id: string;
    product_name: string;
    quantity: string;
    unit: string;
    captured_unit_price: string;
  }>;
}

const STATUS_OPTIONS: ReadonlyArray<{
  value: OrderFilter;
  label: string;
}> = [
  { value: "all", label: "All local orders" },
  { value: "local_draft", label: "Local drafts" },
  { value: "pending_sync", label: "Pending synchronization" },
  { value: "syncing", label: "Synchronizing" },
  { value: "synced", label: "Synchronized" },
  { value: "sync_failed", label: "Synchronization failed" },
  { value: "conflict", label: "Conflicts" },
];

function newLine(): OrderLineForm {
  return {
    clientId: crypto.randomUUID(),
    productId: "",
    quantity: "",
    unitPrice: "",
  };
}

function newEditor(): OrderEditorState {
  return {
    mode: "create",
    localId: null,
    customerId: "",
    notes: "",
    lines: [newLine()],
  };
}

function isDecimal(value: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(value.trim());
}

function isPositiveDecimal(value: string): boolean {
  const trimmed = value.trim();

  return (
    isDecimal(trimmed) &&
    /[1-9]/.test(trimmed.replace(".", ""))
  );
}

function hasDecimalPlaces(
  value: string,
  maximum: number,
): boolean {
  const fraction = value.trim().split(".")[1];

  return (fraction?.length ?? 0) <= maximum;
}

function normalizeOrder(order: OfflineOrder): OrderRecord {
  return {
    localId: order.local_id,
    ownerId: order.salesman_id,
    customerId: order.customer_id,
    customerName: order.customer_name,
    notes: order.notes ?? "",
    status: order.sync_status,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    idempotencyKey: order.idempotency_key,
    serverOrderId: order.server_order_id,
    errorMessage: order.sync_error?.message ?? null,
    items: order.items.map((item) => ({
      productId: item.product_id,
      productName: item.product_name,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.captured_unit_price,
    })),
  };
}

function toStoredOrder(
  record: OrderRecord,
): OfflineOrder {
  const stored: OfflineOrderStorage = {
    local_id: record.localId,
    salesman_id: record.ownerId,
    customer_id: record.customerId,
    customer_name: record.customerName,
    notes: record.notes || null,
    sync_status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    idempotency_key: record.idempotencyKey,
    server_order_id: record.serverOrderId,
    sync_error: null,
    items: record.items.map((item) => ({
      id: item.productId,
      product_id: item.productId,
      product_name: item.productName,
      quantity: item.quantity,
      unit: item.unit,
      captured_unit_price: item.unitPrice,
    })),
  };

  const now = record.updatedAt;
  return {
    local_id: stored.local_id,
    idempotency_key: stored.idempotency_key,
    salesman_id: stored.salesman_id,
    customer_id: stored.customer_id,
    customer_name: stored.customer_name,
    order_date: record.createdAt,
    notes: stored.notes,
    items: stored.items.map((item) => ({
      id: item.id,
      product_id: item.product_id,
      product_name: item.product_name,
      quantity: item.quantity,
      unit: item.unit as OfflineOrder["items"][number]["unit"],
      captured_unit_price: item.captured_unit_price,
    })),
    sync_status: stored.sync_status,
    server_order_id: stored.server_order_id,
    server_order_number: null,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
    submitted_at: stored.sync_status === "local_draft" ? null : now,
    last_sync_attempt_at: null,
    synced_at: stored.sync_status === "synced" ? now : null,
    sync_attempt_count: 0,
    next_retry_at: null,
      sync_error: null,
  };
}

function createCounts(
  orders: readonly OrderRecord[],
): SyncStatusCounts {
  return {
    localDraft: orders.filter(
      (order) => order.status === "local_draft",
    ).length,
    pendingSync: orders.filter(
      (order) => order.status === "pending_sync",
    ).length,
    syncing: orders.filter(
      (order) => order.status === "syncing",
    ).length,
    synced: orders.filter(
      (order) => order.status === "synced",
    ).length,
    syncFailed: orders.filter(
      (order) => order.status === "sync_failed",
    ).length,
    conflict: orders.filter(
      (order) => order.status === "conflict",
    ).length,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return getApiErrorMessage(error);
}

export function OfflineOrdersPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canAccess =
    user?.role === USER_ROLES.SALESMAN;

  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [customers, setCustomers] =
    useState<CachedCustomerOption[]>([]);
  const [products, setProducts] =
    useState<CachedProductOption[]>([]);
  const [prices, setPrices] =
    useState<CachedPriceOption[]>([]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<OrderFilter>("all");

  const [editor, setEditor] =
    useState<OrderEditorState | null>(null);

  const [selectedOrder, setSelectedOrder] =
    useState<OrderRecord | null>(null);

  const [deleteTarget, setDeleteTarget] =
    useState<OrderRecord | null>(null);

  const [lastSyncedAt, setLastSyncedAt] =
    useState<string | null>(null);

  const [lastAttemptedAt, setLastAttemptedAt] =
    useState<string | null>(null);

  const [backendReachable, setBackendReachable] =
    useState<boolean | null>(null);

  const operationLock = useRef(false);

  const userId = user?.id ?? null;

  const loadData = useCallback(async (): Promise<void> => {
    if (!canAccess || !userId) {
      setOrders([]);
      setCustomers([]);
      setProducts([]);
      setPrices([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [
        storedOrders,
        cachedCustomers,
        cachedProducts,
        cachedPrices,
      ] = await Promise.all([
        getOfflineOrders(userId),
        getCachedCustomers(userId),
        getCachedProducts(userId),
        getCachedPrices(userId),
      ]);

      const ownedOrders = storedOrders
        .map(normalizeOrder)
        .filter((order) => order.ownerId === userId)
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        );

      setOrders(ownedOrders);
      setCustomers(
        cachedCustomers.map((entry) => ({
          id: entry.customer_id,
          name: entry.customer.name,
          customer_code: entry.customer.customer_code,
          is_active: entry.customer.is_active,
        })),
      );
      setProducts(
        cachedProducts.map((entry) => ({
          id: entry.product_id,
          name: entry.product.name,
          item_code: entry.product.item_code,
          base_unit: entry.product.base_unit,
          is_active: entry.product.is_active,
        })),
      );
      setPrices(
        cachedPrices.map((entry) => ({
          product_id: entry.product_id,
          selling_price: entry.selling_price,
          customer_id: entry.customer_id,
        })),
      );
    } catch (failure) {
      setError(getErrorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [canAccess, userId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const productsById = useMemo(
    () =>
      new Map(
        products.map((product) => [
          product.id,
          product,
        ]),
      ),
    [products],
  );

  const customersById = useMemo(
    () =>
      new Map(
        customers.map((customer) => [
          customer.id,
          customer,
        ]),
      ),
    [customers],
  );

  const counts = useMemo(
    () => createCounts(orders),
    [orders],
  );

  const visibleOrders = useMemo(() => {
    const query = search.trim().toLowerCase();

    return orders.filter((order) => {
      if (
        statusFilter !== "all" &&
        order.status !== statusFilter
      ) {
        return false;
      }

      if (!query) {
        return true;
      }

      return (
        order.customerName.toLowerCase().includes(query) ||
        order.localId.toLowerCase().includes(query) ||
        (order.serverOrderId ?? "")
          .toLowerCase()
          .includes(query)
      );
    });
  }, [orders, search, statusFilter]);

  const syncStatusOrders = useMemo<
    SyncStatusOrder[]
  >(
    () =>
      orders.map((order) => ({
        localId: order.localId,
        customerName: order.customerName,
        status: order.status,
        updatedAt: order.updatedAt,
        errorMessage: order.errorMessage,
      })),
    [orders],
  );

  const getPrice = useCallback(
    (
      productId: string,
      customerId: string,
    ): string => {
      const customerPrice = prices.find(
        (price) =>
          price.product_id === productId &&
          price.customer_id === customerId,
      );

      if (customerPrice) {
        return customerPrice.selling_price;
      }

      const generalPrice = prices.find(
        (price) =>
          price.product_id === productId &&
          !price.customer_id,
      );

      return generalPrice?.selling_price ?? "";
    },
    [prices],
  );

  const openCreate = (): void => {
    setEditor(newEditor());
    setError(null);
    setSuccess(null);
  };

  const openEdit = (order: OrderRecord): void => {
    if (
      !isOfflineOrderEditable(order.status)
    ) {
      setError(
        "This order cannot be edited in its current synchronization state.",
      );
      return;
    }

    setEditor({
      mode: "edit",
      localId: order.localId,
      customerId: order.customerId,
      notes: order.notes,
      lines: order.items.map((item) => ({
        clientId: crypto.randomUUID(),
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
    });

    setError(null);
    setSuccess(null);
  };

  const updateEditor = (
    field: "customerId" | "notes",
    value: string,
  ): void => {
    setEditor((current) => {
      if (!current) {
        return null;
      }

      if (field === "customerId") {
        return {
          ...current,
          customerId: value,
          lines: current.lines.map((line) => ({
            ...line,
            unitPrice: line.productId
              ? getPrice(line.productId, value)
              : "",
          })),
        };
      }

      return {
        ...current,
        notes: value,
      };
    });
  };

  const updateLine = (
    clientId: string,
    field: "productId" | "quantity",
    value: string,
  ): void => {
    setEditor((current) => {
      if (!current) {
        return null;
      }

      return {
        ...current,
        lines: current.lines.map((line) => {
          if (line.clientId !== clientId) {
            return line;
          }

          if (field === "productId") {
            return {
              ...line,
              productId: value,
              quantity: "",
              unitPrice: getPrice(
                value,
                current.customerId,
              ),
            };
          }

          return {
            ...line,
            quantity: value,
          };
        }),
      };
    });
  };

  const addLine = (): void => {
    setEditor((current) => {
      if (
        !current ||
        current.lines.length >= MAX_ORDER_ITEMS
      ) {
        return current;
      }

      return {
        ...current,
        lines: [...current.lines, newLine()],
      };
    });
  };

  const removeLine = (clientId: string): void => {
    setEditor((current) => {
      if (
        !current ||
        current.lines.length <= 1
      ) {
        return current;
      }

      return {
        ...current,
        lines: current.lines.filter(
          (line) => line.clientId !== clientId,
        ),
      };
    });
  };

  const validateEditor = (
    current: OrderEditorState,
  ): string | null => {
    if (!current.customerId) {
      return "Select a cached customer.";
    }

    const customer = customersById.get(
      current.customerId,
    );

    if (!customer) {
      return "The selected customer is not available in the local cache.";
    }

    if (customer.is_active === false) {
      return "The selected customer is marked inactive in the local cache.";
    }

    if (
      current.notes.length > MAX_NOTES_LENGTH
    ) {
      return "Order notes exceed the permitted length.";
    }

    if (
      current.lines.length === 0 ||
      current.lines.length > MAX_ORDER_ITEMS
    ) {
      return "The order must contain a valid number of items.";
    }

    const selectedProducts = new Set<string>();

    for (
      let index = 0;
      index < current.lines.length;
      index += 1
    ) {
      const line = current.lines[index];

      if (!line) {
        return "An order item is missing.";
      }

      const product = productsById.get(
        line.productId,
      );

      if (!product) {
        return `Select a cached product for item ${index + 1}.`;
      }

      if (product.is_active === false) {
        return `Product ${product.name} is marked inactive in the local cache.`;
      }

      if (selectedProducts.has(product.id)) {
        return `Product ${product.name} is selected more than once.`;
      }

      selectedProducts.add(product.id);

      if (
        !isPositiveDecimal(line.quantity) ||
        !hasDecimalPlaces(line.quantity, 6)
      ) {
        return `Enter a valid positive quantity for item ${index + 1}.`;
      }

      if (
        !isDecimal(line.unitPrice) ||
        !hasDecimalPlaces(line.unitPrice, 2)
      ) {
        return `A valid cached price is required for item ${index + 1}.`;
      }
    }

    return null;
  };

  const persistEditor = async (
    submitForSync: boolean,
  ): Promise<void> => {
    if (
      !editor ||
      !userId ||
      busy ||
      operationLock.current
    ) {
      return;
    }

    const validationError = validateEditor(editor);

    if (validationError) {
      setError(validationError);
      return;
    }

    const customer = customersById.get(
      editor.customerId,
    );

    if (!customer) {
      setError("The selected customer is unavailable.");
      return;
    }

    const existing =
      editor.localId === null
        ? null
        : orders.find(
            (order) =>
              order.localId === editor.localId,
          );

    if (
      editor.mode === "edit" &&
      (!existing ||
        !isOfflineOrderEditable(existing.status))
    ) {
      setError(
        "The local order is no longer editable. Refresh the order list.",
      );
      return;
    }

    const now = new Date().toISOString();

    const record: OrderRecord = {
      localId:
        existing?.localId ??
        crypto.randomUUID(),
      ownerId: userId,
      customerId: editor.customerId,
      customerName: customer.name,
      notes: editor.notes.trim(),
      status: submitForSync
        ? "pending_sync"
        : "local_draft",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      idempotencyKey:
        existing?.idempotencyKey ??
        crypto.randomUUID(),
      serverOrderId: null,
      errorMessage: null,
      items: editor.lines.map((line) => {
        const product = productsById.get(
          line.productId,
        );

        if (!product) {
          throw new Error(
            "A selected product is unavailable.",
          );
        }

        return {
          productId: product.id,
          productName: product.name,
          quantity: line.quantity.trim(),
          unit: product.base_unit,
          unitPrice: line.unitPrice.trim(),
        };
      }),
    };

    operationLock.current = true;
    setBusy(true);
    setError(null);
    setSuccess(null);

    try {
      await saveOfflineOrder(userId, toStoredOrder(record));

      setEditor(null);

      setSuccess(
        submitForSync
          ? "Order saved locally and queued for synchronization. Backend acceptance has not yet been confirmed."
          : "Local draft saved successfully.",
      );

      await loadData();
    } catch (failure) {
      setError(getErrorMessage(failure));
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  };

  const handleSave = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();
    void persistEditor(false);
  };

  const queueOrder = async (
    order: OrderRecord,
  ): Promise<void> => {
    if (
      !userId ||
      busy ||
      operationLock.current ||
      order.status !== "local_draft"
    ) {
      return;
    }

    operationLock.current = true;
    setBusy(true);
    setError(null);

    try {
      await saveOfflineOrder(userId, toStoredOrder({
          ...order,
          status: "pending_sync",
          updatedAt: new Date().toISOString(),
          errorMessage: null,
        }));

      setSuccess(
        "Order queued locally. Synchronization has not yet been confirmed.",
      );

      await loadData();
    } catch (failure) {
      setError(getErrorMessage(failure));
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  };

  const syncAll = async (): Promise<void> => {
    if (
      !userId ||
      !isOnline ||
      syncing ||
      operationLock.current
    ) {
      return;
    }

    operationLock.current = true;
    setSyncing(true);
    setError(null);
    setSuccess(null);
    setLastAttemptedAt(
      new Date().toISOString(),
    );

    try {
      await syncPendingOrders(userId);

      setBackendReachable(true);
      setLastSyncedAt(
        new Date().toISOString(),
      );

      await loadData();

      setSuccess(
        "Synchronization attempt completed. Review individual order statuses for backend confirmation.",
      );
    } catch (failure) {
      setBackendReachable(false);
      setError(getErrorMessage(failure));

      await loadData();
    } finally {
      operationLock.current = false;
      setSyncing(false);
    }
  };

  const retryOrder = async (
    localId: string,
  ): Promise<void> => {
    if (
      !userId ||
      !isOnline ||
      syncing ||
      operationLock.current
    ) {
      return;
    }

    const order = orders.find(
      (item) => item.localId === localId,
    );

    if (
      !order ||
      !isOfflineOrderRetryable(order.status)
    ) {
      setError(
        "The selected order is not eligible for retry.",
      );
      return;
    }

    operationLock.current = true;
    setSyncing(true);
    setError(null);
    setLastAttemptedAt(
      new Date().toISOString(),
    );

    try {
      await syncOfflineOrder(
        userId,
        localId,
      );

      setBackendReachable(true);
      await loadData();

      setSuccess(
        "Retry completed. Check the order status for backend confirmation.",
      );
    } catch (failure) {
      setError(getErrorMessage(failure));
      await loadData();
    } finally {
      operationLock.current = false;
      setSyncing(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (
      !deleteTarget ||
      !userId ||
      busy ||
      operationLock.current
    ) {
      return;
    }

    if (
      deleteTarget.status !== "local_draft"
    ) {
      setError(
        "Only unsent local drafts can be deleted from this screen.",
      );
      setDeleteTarget(null);
      return;
    }

    operationLock.current = true;
    setBusy(true);
    setError(null);

    try {
      await deleteOfflineOrder(
        userId,
        deleteTarget.localId,
      );

      setDeleteTarget(null);
      setSuccess("Local draft deleted.");

      await loadData();
    } catch (failure) {
      setError(getErrorMessage(failure));
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  };

  if (!canAccess) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Offline Orders
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Offline order capture is restricted to
          the Salesman role.
        </div>

        <Link
          to="/sales/orders"
          className="app-button app-button-secondary"
        >
          Back to sales orders
        </Link>
      </div>
    );
  }

  return (
    <div className="app-page space-y-6">
      <header className="space-y-4">
        <Link
          to="/sales/orders"
          className="inline-flex items-center gap-2 text-sm font-medium text-accent hover:underline"
        >
          <ArrowLeft
            size={17}
            aria-hidden="true"
          />
          Sales orders
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <Database
                size={26}
                className="text-primary"
                aria-hidden="true"
              />

              <h2 className="app-page-title">
                Offline Orders
              </h2>
            </div>

            <p className="app-page-description">
              Capture customer orders locally,
              manage drafts, and synchronize them
              when the backend is available.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void loadData();
              }}
              disabled={loading || busy || syncing}
              className="app-button app-button-secondary inline-flex items-center gap-2"
            >
              <RefreshCw
                size={17}
                className={
                  loading
                    ? "motion-safe:animate-spin"
                    : ""
                }
                aria-hidden="true"
              />
              Refresh
            </button>

            <button
              type="button"
              onClick={openCreate}
              disabled={busy || syncing}
              className="app-button app-button-primary inline-flex items-center gap-2"
            >
              <Plus
                size={17}
                aria-hidden="true"
              />
              New local order
            </button>
          </div>
        </div>
      </header>

      {!isOnline && (
        <div
          role="status"
          className="app-alert app-alert-warning flex items-start gap-3"
        >
          <WifiOff
            size={20}
            className="shrink-0"
            aria-hidden="true"
          />

          <p>
            The device is offline. Previously cached
            customers, products, and prices remain
            available. Local orders will not become
            official until backend synchronization
            succeeds.
          </p>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="app-alert app-alert-error flex items-start gap-3"
        >
          <AlertCircle
            size={19}
            className="shrink-0"
            aria-hidden="true"
          />

          <p>{error}</p>
        </div>
      )}

      {success && (
        <div
          role="status"
          className="app-alert app-alert-success flex items-start gap-3"
        >
          <CheckCircle2
            size={19}
            className="shrink-0"
            aria-hidden="true"
          />

          <p>{success}</p>
        </div>
      )}

      <SyncStatus
        counts={counts}
        orders={syncStatusOrders}
        isSyncing={syncing}
        isLoading={loading}
        isBackendReachable={backendReachable}
        lastSyncedAt={lastSyncedAt}
        lastAttemptedAt={lastAttemptedAt}
        onSync={syncAll}
        onRetryOrder={retryOrder}
        onRefresh={loadData}
        compact
      />

      <section className="app-card space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-text-primary">
              Local order register
            </h3>

            <p className="mt-1 text-sm text-text-muted">
              Records stored for the authenticated
              Salesman account.
            </p>
          </div>

          <span className="text-sm text-text-muted">
            {visibleOrders.length} order
            {visibleOrders.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label
              htmlFor="offline-order-search"
              className="app-field-label mb-2 block"
            >
              Search
            </label>

            <div className="relative">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />

              <input
                id="offline-order-search"
                type="search"
                value={search}
                onChange={(event) =>
                  setSearch(event.target.value)
                }
                placeholder="Customer or order reference..."
                className="app-input w-full pl-10"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="offline-order-status"
              className="app-field-label mb-2 block"
            >
              Synchronization status
            </label>

            <select
              id="offline-order-status"
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(
                  event.target.value as OrderFilter,
                )
              }
              className="app-select w-full"
            >
              {STATUS_OPTIONS.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                >
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {loading ? (
          <LoadingState
            variant="section"
            message="Loading locally stored orders..."
          />
        ) : visibleOrders.length === 0 ? (
          <div className="rounded-control border border-dashed border-border p-8 text-center">
            <ClipboardList
              size={32}
              className="mx-auto text-text-muted"
              aria-hidden="true"
            />

            <p className="mt-3 font-medium text-text-primary">
              No local orders found
            </p>

            <p className="mt-1 text-sm text-text-muted">
              Create a local order or change the
              search filters.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {visibleOrders.map((order) => (
              <article
                key={order.localId}
                className="rounded-control border border-border bg-surface p-4"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-semibold text-text-primary">
                        {order.customerName}
                      </h4>

                      <OfflineStatusBadge
                        status={order.status}
                      />
                    </div>

                    <p className="break-all text-xs text-text-muted">
                      Local ID: {order.localId}
                    </p>

                    {order.serverOrderId && (
                      <p className="break-all text-xs text-success">
                        Official order ID:{" "}
                        {order.serverOrderId}
                      </p>
                    )}

                    <p className="text-xs text-text-muted">
                      Updated:{" "}
                      {formatDateTime(order.updatedAt)}
                    </p>

                    <p className="text-sm text-text-muted">
                      {order.items.length} item
                      {order.items.length === 1
                        ? ""
                        : "s"}
                    </p>

                    {order.errorMessage && (
                      <p
                        role="alert"
                        className="whitespace-pre-wrap text-xs text-error"
                      >
                        {order.errorMessage}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedOrder(order)
                      }
                      className="app-button app-button-secondary inline-flex items-center gap-2"
                    >
                      <Eye
                        size={15}
                        aria-hidden="true"
                      />
                      Details
                    </button>

                    {isOfflineOrderEditable(
                      order.status,
                    ) && (
                      <button
                        type="button"
                        onClick={() => openEdit(order)}
                        disabled={busy || syncing}
                        className="app-button app-button-secondary inline-flex items-center gap-2"
                      >
                        <Edit3
                          size={15}
                          aria-hidden="true"
                        />
                        Edit
                      </button>
                    )}

                    {order.status ===
                      "local_draft" && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            void queueOrder(order);
                          }}
                          disabled={busy || syncing}
                          className="app-button app-button-primary inline-flex items-center gap-2"
                        >
                          <Send
                            size={15}
                            aria-hidden="true"
                          />
                          Queue
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            setDeleteTarget(order)
                          }
                          disabled={busy || syncing}
                          className="app-button app-button-danger inline-flex items-center gap-2"
                        >
                          <Trash2
                            size={15}
                            aria-hidden="true"
                          />
                          Delete
                        </button>
                      </>
                    )}

                    {isOfflineOrderRetryable(
                      order.status,
                    ) && (
                      <button
                        type="button"
                        onClick={() => {
                          void retryOrder(
                            order.localId,
                          );
                        }}
                        disabled={
                          !isOnline ||
                          busy ||
                          syncing
                        }
                        className="app-button app-button-secondary inline-flex items-center gap-2"
                      >
                        <CloudUpload
                          size={15}
                          aria-hidden="true"
                        />
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {editor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-5">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="offline-editor-title"
            className="flex max-h-[95vh] w-full max-w-4xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-xl"
          >
            <header className="flex items-start justify-between gap-4 border-b border-border p-5">
              <div>
                <h3
                  id="offline-editor-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  {editor.mode === "create"
                    ? "Create local order"
                    : "Edit local draft"}
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Data is saved in IndexedDB before
                  synchronization.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setEditor(null)}
                disabled={busy}
                aria-label="Close editor"
                className="rounded-control p-2 text-text-muted hover:bg-background"
              >
                <X
                  size={20}
                  aria-hidden="true"
                />
              </button>
            </header>

            <form
              onSubmit={handleSave}
              className="min-h-0 flex-1 overflow-y-auto"
            >
              <div className="space-y-6 p-5">
                <div>
                  <label
                    htmlFor="offline-customer"
                    className="app-field-label mb-2 block"
                  >
                    Customer *
                  </label>

                  <select
                    id="offline-customer"
                    value={editor.customerId}
                    onChange={(event) =>
                      updateEditor(
                        "customerId",
                        event.target.value,
                      )
                    }
                    required
                    disabled={busy}
                    className="app-select w-full"
                  >
                    <option value="">
                      Select cached customer
                    </option>

                    {customers.map((customer) => (
                      <option
                        key={customer.id}
                        value={customer.id}
                        disabled={
                          customer.is_active === false
                        }
                      >
                        {customer.customer_code
                          ? `${customer.customer_code} — `
                          : ""}
                        {customer.name}
                      </option>
                    ))}
                  </select>

                  {customers.length === 0 && (
                    <p className="app-field-help mt-2">
                      No cached customers are available.
                      Reference data must be loaded while
                      connected to the backend.
                    </p>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h4 className="font-semibold text-text-primary">
                      Order items
                    </h4>

                    <button
                      type="button"
                      onClick={addLine}
                      disabled={
                        busy ||
                        editor.lines.length >=
                          MAX_ORDER_ITEMS
                      }
                      className="app-button app-button-secondary inline-flex items-center gap-2"
                    >
                      <Plus
                        size={16}
                        aria-hidden="true"
                      />
                      Add item
                    </button>
                  </div>

                  {editor.lines.map(
                    (line, index) => {
                      const product =
                        productsById.get(
                          line.productId,
                        );

                      return (
                        <div
                          key={line.clientId}
                          className="space-y-4 rounded-control border border-border bg-background p-4"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <h5 className="text-sm font-semibold text-text-primary">
                              Item {index + 1}
                            </h5>

                            <button
                              type="button"
                              onClick={() =>
                                removeLine(
                                  line.clientId,
                                )
                              }
                              disabled={
                                busy ||
                                editor.lines.length <=
                                  1
                              }
                              aria-label={`Remove item ${index + 1}`}
                              className="text-error disabled:opacity-50"
                            >
                              <Trash2
                                size={17}
                                aria-hidden="true"
                              />
                            </button>
                          </div>

                          <div className="grid gap-4 md:grid-cols-3">
                            <div>
                              <label
                                htmlFor={`offline-product-${line.clientId}`}
                                className="app-field-label mb-2 block"
                              >
                                Product *
                              </label>

                              <select
                                id={`offline-product-${line.clientId}`}
                                value={line.productId}
                                onChange={(event) =>
                                  updateLine(
                                    line.clientId,
                                    "productId",
                                    event.target.value,
                                  )
                                }
                                required
                                disabled={busy}
                                className="app-select w-full"
                              >
                                <option value="">
                                  Select product
                                </option>

                                {products.map(
                                  (item) => (
                                    <option
                                      key={item.id}
                                      value={item.id}
                                      disabled={
                                        item.is_active ===
                                        false
                                      }
                                    >
                                      {item.item_code
                                        ? `${item.item_code} — `
                                        : ""}
                                      {item.name}
                                    </option>
                                  ),
                                )}
                              </select>
                            </div>

                            <div>
                              <label
                                htmlFor={`offline-quantity-${line.clientId}`}
                                className="app-field-label mb-2 block"
                              >
                                Quantity *
                              </label>

                              <input
                                id={`offline-quantity-${line.clientId}`}
                                type="text"
                                inputMode="decimal"
                                value={line.quantity}
                                onChange={(event) =>
                                  updateLine(
                                    line.clientId,
                                    "quantity",
                                    event.target.value,
                                  )
                                }
                                required
                                disabled={busy}
                                className="app-input w-full"
                              />

                              {product && (
                                <p className="app-field-help mt-1">
                                  Unit:{" "}
                                  {product.base_unit}
                                </p>
                              )}
                            </div>

                            <div>
                              <label
                                htmlFor={`offline-price-${line.clientId}`}
                                className="app-field-label mb-2 block"
                              >
                                Cached unit price
                              </label>

                              <input
                                id={`offline-price-${line.clientId}`}
                                type="text"
                                value={
                                  line.unitPrice
                                    ? formatCurrency(
                                        line.unitPrice,
                                      )
                                    : "Unavailable"
                                }
                                readOnly
                                className="app-input w-full bg-surface"
                              />
                            </div>
                          </div>
                        </div>
                      );
                    },
                  )}
                </div>

                <div>
                  <label
                    htmlFor="offline-notes"
                    className="app-field-label mb-2 block"
                  >
                    Notes
                  </label>

                  <textarea
                    id="offline-notes"
                    value={editor.notes}
                    onChange={(event) =>
                      updateEditor(
                        "notes",
                        event.target.value,
                      )
                    }
                    maxLength={MAX_NOTES_LENGTH}
                    rows={3}
                    disabled={busy}
                    className="app-textarea w-full"
                  />

                  <p className="app-field-help mt-1">
                    {editor.notes.length}/
                    {MAX_NOTES_LENGTH} characters
                  </p>
                </div>

                <div className="rounded-control border border-border p-4 text-xs leading-5 text-text-muted">
                  Cached prices are informational until
                  backend validation. Saving a draft does
                  not create an official order, calculate
                  authoritative GST, reserve inventory,
                  or trigger dispatch.
                </div>
              </div>

              <footer className="flex flex-wrap justify-end gap-3 border-t border-border p-5">
                <button
                  type="button"
                  onClick={() =>
                    setEditor(null)
                  }
                  disabled={busy}
                  className="app-button app-button-secondary"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={busy}
                  className="app-button app-button-secondary inline-flex items-center gap-2"
                >
                  <Save
                    size={16}
                    aria-hidden="true"
                  />
                  Save draft
                </button>

                <button
                  type="button"
                  onClick={() => {
                    void persistEditor(true);
                  }}
                  disabled={busy}
                  className="app-button app-button-primary inline-flex items-center gap-2"
                >
                  <Send
                    size={16}
                    aria-hidden="true"
                  />
                  Save and queue
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {selectedOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="offline-details-title"
            className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-xl"
          >
            <header className="flex items-start justify-between gap-4 border-b border-border p-5">
              <div>
                <h3
                  id="offline-details-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  Local order details
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  {selectedOrder.customerName}
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  setSelectedOrder(null)
                }
                aria-label="Close details"
                className="rounded-control p-2 text-text-muted hover:bg-background"
              >
                <X
                  size={20}
                  aria-hidden="true"
                />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              <OfflineStatusBadge
                status={selectedOrder.status}
              />

              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-text-muted">
                    Local reference
                  </dt>

                  <dd className="mt-1 break-all font-medium">
                    {selectedOrder.localId}
                  </dd>
                </div>

                <div>
                  <dt className="text-text-muted">
                    Official order reference
                  </dt>

                  <dd className="mt-1 break-all font-medium">
                    {selectedOrder.serverOrderId ??
                      "Not confirmed"}
                  </dd>
                </div>

                <div>
                  <dt className="text-text-muted">
                    Created
                  </dt>

                  <dd className="mt-1 font-medium">
                    {formatDateTime(
                      selectedOrder.createdAt,
                    )}
                  </dd>
                </div>

                <div>
                  <dt className="text-text-muted">
                    Updated
                  </dt>

                  <dd className="mt-1 font-medium">
                    {formatDateTime(
                      selectedOrder.updatedAt,
                    )}
                  </dd>
                </div>
              </dl>

              <div className="app-table-container">
                <table className="app-table w-full">
                  <thead>
                    <tr>
                      <th scope="col">Product</th>
                      <th
                        scope="col"
                        className="text-right"
                      >
                        Quantity
                      </th>
                      <th
                        scope="col"
                        className="text-right"
                      >
                        Captured price
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {selectedOrder.items.map(
                      (item, index) => (
                        <tr
                          key={`${item.productId}-${index}`}
                        >
                          <td>
                            {item.productName}
                          </td>

                          <td className="app-numeric text-right">
                            {formatQuantity(
                              item.quantity,
                            )}{" "}
                            {item.unit}
                          </td>

                          <td className="app-numeric text-right">
                            {formatCurrency(
                              item.unitPrice,
                            )}
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>

              {selectedOrder.notes && (
                <div>
                  <h4 className="text-sm font-semibold">
                    Notes
                  </h4>

                  <p className="mt-2 whitespace-pre-wrap text-sm text-text-muted">
                    {selectedOrder.notes}
                  </p>
                </div>
              )}

              {selectedOrder.errorMessage && (
                <div
                  role="alert"
                  className="app-alert app-alert-error"
                >
                  {selectedOrder.errorMessage}
                </div>
              )}
            </div>

            <footer className="flex justify-end border-t border-border p-5">
              <button
                type="button"
                onClick={() =>
                  setSelectedOrder(null)
                }
                className="app-button app-button-secondary"
              >
                Close
              </button>
            </footer>
          </section>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete local draft"
        message={
          deleteTarget
            ? `Delete the unsent draft for ${deleteTarget.customerName}?`
            : ""
        }
        description="This permanently removes the selected local draft. Pending, failed, conflicting, and synchronized orders cannot be deleted through this action."
        variant="danger"
        confirmLabel="Delete draft"
        cancelLabel="Cancel"
        isLoading={busy}
        onCancel={() =>
          setDeleteTarget(null)
        }
        onConfirm={confirmDelete}
      />
    </div>
  );
}

export default OfflineOrdersPage;
