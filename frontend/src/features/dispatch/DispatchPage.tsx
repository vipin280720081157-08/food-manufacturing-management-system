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
  CheckCircle2,
  ClipboardCheck,
  FilterX,
  Package,
  Plus,
  RefreshCw,
  Search,
  Truck,
  WifiOff,
  X,
} from "lucide-react";

import { Link } from "react-router-dom";

import { USER_ROLES } from "../../types/auth";

import type {
  PaginatedResponse,
  TransactionStatus,
  UUID,
  UnitOfMeasure,
} from "../../types/business";

import { useAuth } from "../../hooks/useAuth";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";

import {
  apiClient,
  getApiErrorMessage,
} from "../../services/api/client";

import {
  DataTable,
  type DataTableColumn,
} from "../../components/tables/DataTable";

import { LoadingState } from "../../components/common/LoadingState";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { StatusBadge } from "../../components/common/StatusBadge";

import {
  formatDate,
  formatDateTime,
  formatQuantity,
} from "../../utils/formatters";

const PAGE_SIZE = 20;
const MAX_NOTES_LENGTH = 2000;

type DispatchStatusFilter = "all" | TransactionStatus;

interface DispatchRecord {
  id: UUID;
  dispatch_number: string;
  sales_order_id: UUID;
  sales_order_number: string | null;
  invoice_id: UUID | null;
  invoice_number: string | null;
  customer_id: UUID;
  customer_name: string;
  dispatch_date: string;
  status: TransactionStatus;
  vehicle_number: string | null;
  transporter_name: string | null;
  reference_number: string | null;
  notes: string | null;
  created_at: string;
  posted_at: string | null;
  items: DispatchItem[];
}

interface DispatchItem {
  id: UUID;
  dispatch_id: UUID;
  sales_order_item_id: UUID;
  product_id: UUID;
  product_name: string;
  quantity: string;
  unit: UnitOfMeasure;
  batch_id: UUID;
  batch_number: string;
  expiry_date: string | null;
}

interface DispatchOrderItem {
  id: UUID;
  product_id: UUID;
  product_name: string;
  ordered_quantity: string;
  dispatched_quantity: string;
  remaining_quantity: string;
  unit: UnitOfMeasure;
}

interface DispatchEligibleOrder {
  id: UUID;
  order_number: string;
  customer_id: UUID;
  customer_name: string;
  invoice_id: UUID | null;
  invoice_number: string | null;
  approval_status: string;
  fulfillment_status: string;
  items: DispatchOrderItem[];
}

interface AvailableBatch {
  id: UUID;
  item_id: UUID;
  batch_number: string;
  expiry_date: string | null;
  available_quantity: string;
  unit: UnitOfMeasure;
  status?: string;
}

interface DispatchLineForm {
  client_id: string;
  sales_order_item_id: UUID;
  product_id: UUID;
  product_name: string;
  remaining_quantity: string;
  unit: UnitOfMeasure;
  batch_id: UUID;
  quantity: string;
}

interface DispatchFormState {
  sales_order_id: UUID;
  dispatch_date: string;
  vehicle_number: string;
  transporter_name: string;
  reference_number: string;
  notes: string;
  lines: DispatchLineForm[];
}

interface DispatchFilters {
  page: number;
  search: string;
  status: DispatchStatusFilter;
  date_from: string;
  date_to: string;
}

const STATUS_OPTIONS: ReadonlyArray<{
  value: DispatchStatusFilter;
  label: string;
}> = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "posted", label: "Posted" },
  { value: "cancelled", label: "Cancelled" },
];

function todayLocal(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function parseDecimal(value: string): {
  coefficient: bigint;
  scale: number;
} | null {
  const normalized = value.trim();

  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return null;
  }

  const [whole = "0", fraction = ""] =
    normalized.split(".");

  return {
    coefficient: BigInt(whole + fraction),
    scale: fraction.length,
  };
}

function compareDecimal(
  left: string,
  right: string,
): number | null {
  const a = parseDecimal(left);
  const b = parseDecimal(right);

  if (!a || !b) {
    return null;
  }

  const scale = Math.max(a.scale, b.scale);

  const leftValue =
    a.coefficient * 10n ** BigInt(scale - a.scale);

  const rightValue =
    b.coefficient * 10n ** BigInt(scale - b.scale);

  if (leftValue < rightValue) {
    return -1;
  }

  if (leftValue > rightValue) {
    return 1;
  }

  return 0;
}

function addDecimal(
  left: string,
  right: string,
): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);

  if (!a || !b) {
    throw new Error("Invalid decimal quantity.");
  }

  const scale = Math.max(a.scale, b.scale);

  const total =
    a.coefficient * 10n ** BigInt(scale - a.scale) +
    b.coefficient * 10n ** BigInt(scale - b.scale);

  if (scale === 0) {
    return total.toString();
  }

  const digits = total.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole;
}

function isPositiveQuantity(value: string): boolean {
  const parsed = parseDecimal(value);

  return (
    parsed !== null &&
    parsed.coefficient > 0n &&
    parsed.scale <= 6
  );
}

function newForm(): DispatchFormState {
  return {
    sales_order_id: "",
    dispatch_date: todayLocal(),
    vehicle_number: "",
    transporter_name: "",
    reference_number: "",
    notes: "",
    lines: [],
  };
}

async function fetchDispatches(
  filters: DispatchFilters,
  signal?: AbortSignal,
): Promise<PaginatedResponse<DispatchRecord>> {
  return apiClient.get<PaginatedResponse<DispatchRecord>>(
    "/dispatches",
    {
      query: {
        page: filters.page,
        page_size: PAGE_SIZE,
        search: filters.search || undefined,
        status:
          filters.status === "all"
            ? undefined
            : filters.status,
        date_from: filters.date_from || undefined,
        date_to: filters.date_to || undefined,
      },
      signal,
    },
  );
}

async function fetchEligibleOrders(
  signal?: AbortSignal,
): Promise<DispatchEligibleOrder[]> {
  const response = await apiClient.get<
    PaginatedResponse<DispatchEligibleOrder>
  >("/sales/orders", {
    query: {
      approval_status: "approved",
      page: 1,
      page_size: 100,
    },
    signal,
  });

  return response.items.filter(
    (order) =>
      order.approval_status === "approved" &&
      order.fulfillment_status !== "dispatched" &&
      order.invoice_id !== null,
  );
}

async function fetchOrderDetails(
  orderId: UUID,
  signal?: AbortSignal,
): Promise<DispatchEligibleOrder> {
  return apiClient.get<DispatchEligibleOrder>(
    `/sales/orders/${encodeURIComponent(orderId)}`,
    { signal },
  );
}

async function fetchAvailableBatches(
  productId: UUID,
  signal?: AbortSignal,
): Promise<AvailableBatch[]> {
  const response = await apiClient.get<
    PaginatedResponse<AvailableBatch>
  >("/inventory/batches", {
    query: {
      item_id: productId,
      page: 1,
      page_size: 100,
      available_only: true,
    },
    signal,
  });

  return response.items
    .filter((batch) => {
      const available = compareDecimal(
        batch.available_quantity,
        "0",
      );

      return (
        batch.item_id === productId &&
        available !== null &&
        available > 0 &&
        batch.status !== "blocked"
      );
    })
    .sort((left, right) => {
      if (!left.expiry_date && !right.expiry_date) {
        return left.batch_number.localeCompare(
          right.batch_number,
        );
      }

      if (!left.expiry_date) {
        return 1;
      }

      if (!right.expiry_date) {
        return -1;
      }

      return (
        left.expiry_date.localeCompare(right.expiry_date) ||
        left.batch_number.localeCompare(right.batch_number)
      );
    });
}

async function createDispatch(
  payload: {
    sales_order_id: UUID;
    dispatch_date: string;
    vehicle_number: string | null;
    transporter_name: string | null;
    reference_number: string | null;
    notes: string | null;
    items: Array<{
      sales_order_item_id: UUID;
      product_id: UUID;
      batch_id: UUID;
      quantity: string;
      unit: UnitOfMeasure;
    }>;
  },
  idempotencyKey: string,
): Promise<DispatchRecord> {
  return apiClient.post<DispatchRecord>(
    "/dispatches",
    payload,
    { idempotencyKey },
  );
}

async function postDispatch(
  dispatchId: UUID,
  idempotencyKey: string,
): Promise<DispatchRecord> {
  return apiClient.post<DispatchRecord>(
    `/dispatches/${encodeURIComponent(dispatchId)}/post`,
    {},
    { idempotencyKey },
  );
}

export function DispatchPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canAccess =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.PRODUCTION_SUPERVISOR ||
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const canManage =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [dispatches, setDispatches] =
    useState<DispatchRecord[]>([]);

  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [statusFilter, setStatusFilter] =
    useState<DispatchStatusFilter>("all");

  const [dateFromInput, setDateFromInput] = useState("");
  const [dateToInput, setDateToInput] = useState("");

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [filterError, setFilterError] =
    useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [success, setSuccess] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<DispatchFormState>(
    newForm,
  );

  const [eligibleOrders, setEligibleOrders] =
    useState<DispatchEligibleOrder[]>([]);

  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orderLoading, setOrderLoading] = useState(false);

  const [selectedOrder, setSelectedOrder] =
    useState<DispatchEligibleOrder | null>(null);

  const [batchOptions, setBatchOptions] =
    useState<Record<UUID, AvailableBatch[]>>({});

  const [batchesLoading, setBatchesLoading] =
    useState(false);

  const [formError, setFormError] =
    useState<string | null>(null);

  const [creating, setCreating] = useState(false);

  const [postTarget, setPostTarget] =
    useState<DispatchRecord | null>(null);

  const [posting, setPosting] = useState(false);
  const [postError, setPostError] =
    useState<string | null>(null);

  const [detailsTarget, setDetailsTarget] =
    useState<DispatchRecord | null>(null);

  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const mutationLockRef = useRef(false);

  const filters = useMemo<DispatchFilters>(
    () => ({
      page,
      search,
      status: statusFilter,
      date_from: dateFrom,
      date_to: dateTo,
    }),
    [
      page,
      search,
      statusFilter,
      dateFrom,
      dateTo,
    ],
  );

  const loadDispatches = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canAccess) {
        setDispatches([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchDispatches(
          filters,
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setDispatches(response.items);
        setTotal(response.total);
      } catch (failure) {
        if (!signal?.aborted) {
          setError(getApiErrorMessage(failure));
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [canAccess, filters],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadDispatches(controller.signal);

    return () => controller.abort();
  }, [loadDispatches]);

  useEffect(() => {
    if (!createOpen || !canManage || !isOnline) {
      return;
    }

    const controller = new AbortController();

    const loadOrders = async (): Promise<void> => {
      setOrdersLoading(true);
      setFormError(null);

      try {
        const response = await fetchEligibleOrders(
          controller.signal,
        );

        if (!controller.signal.aborted) {
          setEligibleOrders(response);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setFormError(getApiErrorMessage(failure));
        }
      } finally {
        if (!controller.signal.aborted) {
          setOrdersLoading(false);
        }
      }
    };

    void loadOrders();

    return () => controller.abort();
  }, [createOpen, canManage, isOnline]);

  const openCreate = (): void => {
    if (
      !canManage ||
      !isOnline ||
      creating ||
      posting
    ) {
      return;
    }

    setForm(newForm());
    setSelectedOrder(null);
    setBatchOptions({});
    setEligibleOrders([]);
    setFormError(null);
    setSuccess(null);
    createKeyRef.current = null;
    setCreateOpen(true);
  };

  const closeCreate = (): void => {
    if (creating) {
      return;
    }

    setCreateOpen(false);
    setFormError(null);
    setSelectedOrder(null);
    setBatchOptions({});
    createKeyRef.current = null;
  };

  const selectOrder = async (
    orderId: UUID,
  ): Promise<void> => {
    setForm((current) => ({
      ...current,
      sales_order_id: orderId,
      lines: [],
    }));

    setSelectedOrder(null);
    setBatchOptions({});
    setFormError(null);
    createKeyRef.current = null;

    if (!orderId) {
      return;
    }

    setOrderLoading(true);
    setBatchesLoading(true);

    try {
      const order = await fetchOrderDetails(orderId);

      if (
        order.approval_status !== "approved" ||
        order.fulfillment_status === "dispatched" ||
        !order.invoice_id
      ) {
        throw new Error(
          "The selected order is not eligible for dispatch.",
        );
      }

      const remainingItems = order.items.filter(
        (item) =>
          compareDecimal(
            item.remaining_quantity,
            "0",
          ) === 1,
      );

      if (remainingItems.length === 0) {
        throw new Error(
          "The selected order has no remaining quantity to dispatch.",
        );
      }

      const productIds = [
        ...new Set(
          remainingItems.map((item) => item.product_id),
        ),
      ];

      const batchResults = await Promise.all(
        productIds.map(async (productId) => ({
          productId,
          batches: await fetchAvailableBatches(
            productId,
          ),
        })),
      );

      const nextOptions: Record<
        UUID,
        AvailableBatch[]
      > = {};

      for (const result of batchResults) {
        nextOptions[result.productId] =
          result.batches;
      }

      setBatchOptions(nextOptions);
      setSelectedOrder(order);

      setForm((current) => ({
        ...current,
        sales_order_id: order.id,
        lines: remainingItems.map((item) => ({
          client_id: crypto.randomUUID(),
          sales_order_item_id: item.id,
          product_id: item.product_id,
          product_name: item.product_name,
          remaining_quantity:
            item.remaining_quantity,
          unit: item.unit,
          batch_id: "",
          quantity: "",
        })),
      }));
    } catch (failure) {
      setFormError(getApiErrorMessage(failure));
    } finally {
      setOrderLoading(false);
      setBatchesLoading(false);
    }
  };

  const updateFormField = (
    field:
      | "dispatch_date"
      | "vehicle_number"
      | "transporter_name"
      | "reference_number"
      | "notes",
    value: string,
  ): void => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));

    createKeyRef.current = null;
  };

  const updateLine = (
    clientId: string,
    field: "batch_id" | "quantity",
    value: string,
  ): void => {
    setForm((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.client_id === clientId
          ? { ...line, [field]: value }
          : line,
      ),
    }));

    createKeyRef.current = null;
  };

  const validateForm = (): string | null => {
    if (
      !selectedOrder ||
      form.sales_order_id !== selectedOrder.id
    ) {
      return "Select an eligible approved sales order.";
    }

    if (!isValidDate(form.dispatch_date)) {
      return "Enter a valid dispatch date.";
    }

    if (
      form.notes.length > MAX_NOTES_LENGTH
    ) {
      return "Dispatch notes exceed the permitted length.";
    }

    const selectedLines = form.lines.filter(
      (line) => line.quantity.trim() !== "",
    );

    if (selectedLines.length === 0) {
      return "Enter at least one dispatch quantity.";
    }

    const quantityByBatch = new Map<UUID, string>();
    const quantityByOrderItem = new Map<UUID, string>();

    for (const line of selectedLines) {
      if (!isPositiveQuantity(line.quantity)) {
        return `Enter a valid positive quantity for ${line.product_name}.`;
      }

      if (!line.batch_id) {
        return `Select a stock batch for ${line.product_name}.`;
      }

      const batch = (
        batchOptions[line.product_id] ?? []
      ).find(
        (candidate) =>
          candidate.id === line.batch_id,
      );

      if (!batch) {
        return `The selected batch for ${line.product_name} is unavailable.`;
      }

      if (batch.unit !== line.unit) {
        return `The unit for ${line.product_name} does not match the selected batch.`;
      }

      if (
        batch.expiry_date &&
        batch.expiry_date < form.dispatch_date
      ) {
        return `Batch ${batch.batch_number} expires before the dispatch date.`;
      }

      const batchTotal = addDecimal(
        quantityByBatch.get(batch.id) ?? "0",
        line.quantity,
      );

      quantityByBatch.set(
        batch.id,
        batchTotal,
      );

      if (
        compareDecimal(
          batchTotal,
          batch.available_quantity,
        ) === 1
      ) {
        return `Requested quantity exceeds cached availability for batch ${batch.batch_number}.`;
      }

      const itemTotal = addDecimal(
        quantityByOrderItem.get(
          line.sales_order_item_id,
        ) ?? "0",
        line.quantity,
      );

      quantityByOrderItem.set(
        line.sales_order_item_id,
        itemTotal,
      );

      if (
        compareDecimal(
          itemTotal,
          line.remaining_quantity,
        ) === 1
      ) {
        return `Requested quantity exceeds the remaining order quantity for ${line.product_name}.`;
      }
    }

    return null;
  };

  const submitCreate = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      !canManage ||
      !isOnline ||
      creating ||
      mutationLockRef.current
    ) {
      return;
    }

    const validationError = validateForm();

    if (validationError) {
      setFormError(validationError);
      return;
    }

    const idempotencyKey =
      createKeyRef.current ??
      crypto.randomUUID();

    createKeyRef.current = idempotencyKey;
    mutationLockRef.current = true;

    setCreating(true);
    setFormError(null);
    setSuccess(null);

    try {
      const result = await createDispatch(
        {
          sales_order_id: form.sales_order_id,
          dispatch_date: form.dispatch_date,
          vehicle_number:
            form.vehicle_number.trim() || null,
          transporter_name:
            form.transporter_name.trim() || null,
          reference_number:
            form.reference_number.trim() || null,
          notes: form.notes.trim() || null,
          items: form.lines
            .filter(
              (line) =>
                line.quantity.trim() !== "",
            )
            .map((line) => ({
              sales_order_item_id:
                line.sales_order_item_id,
              product_id: line.product_id,
              batch_id: line.batch_id,
              quantity: line.quantity.trim(),
              unit: line.unit,
            })),
        },
        idempotencyKey,
      );

      if (
        !result.id ||
        result.sales_order_id !==
          form.sales_order_id
      ) {
        throw new Error(
          "The backend response did not confirm the requested dispatch. Refresh the register before retrying.",
        );
      }

      setCreateOpen(false);
      createKeyRef.current = null;

      setSuccess(
        `Dispatch ${result.dispatch_number} was created with status "${result.status}". Stock has not been assumed deducted unless the backend confirms posting.`,
      );

      setPage(1);
      await loadDispatches();
    } catch (failure) {
      setFormError(getApiErrorMessage(failure));
    } finally {
      mutationLockRef.current = false;
      setCreating(false);
    }
  };

  const openPost = (
    dispatch: DispatchRecord,
  ): void => {
    if (
      !canManage ||
      !isOnline ||
      dispatch.status !== "draft" ||
      posting ||
      creating
    ) {
      return;
    }

    postKeyRef.current = null;
    setPostError(null);
    setSuccess(null);
    setPostTarget(dispatch);
  };

  const closePost = (): void => {
    if (posting) {
      return;
    }

    setPostTarget(null);
    setPostError(null);
    postKeyRef.current = null;
  };

  const submitPost = async (): Promise<void> => {
    if (
      !postTarget ||
      !canManage ||
      !isOnline ||
      posting ||
      mutationLockRef.current
    ) {
      return;
    }

    const idempotencyKey =
      postKeyRef.current ??
      crypto.randomUUID();

    postKeyRef.current = idempotencyKey;
    mutationLockRef.current = true;

    setPosting(true);
    setPostError(null);
    setSuccess(null);

    try {
      const result = await postDispatch(
        postTarget.id,
        idempotencyKey,
      );

      if (
        result.id !== postTarget.id ||
        result.status !== "posted"
      ) {
        throw new Error(
          "The backend did not confirm dispatch posting. Refresh the register before retrying.",
        );
      }

      setSuccess(
        `Dispatch ${result.dispatch_number} was posted successfully. Inventory movements are managed by the backend.`,
      );

      setPostTarget(null);
      postKeyRef.current = null;

      await loadDispatches();
    } catch (failure) {
      setPostError(getApiErrorMessage(failure));
    } finally {
      mutationLockRef.current = false;
      setPosting(false);
    }
  };

  const handleFilterSubmit = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();

    if (
      dateFromInput &&
      !isValidDate(dateFromInput)
    ) {
      setFilterError(
        "Enter a valid start date.",
      );
      return;
    }

    if (
      dateToInput &&
      !isValidDate(dateToInput)
    ) {
      setFilterError(
        "Enter a valid end date.",
      );
      return;
    }

    if (
      dateFromInput &&
      dateToInput &&
      dateFromInput > dateToInput
    ) {
      setFilterError(
        "The end date cannot precede the start date.",
      );
      return;
    }

    setFilterError(null);
    setPage(1);
    setSearch(searchInput.trim());
    setDateFrom(dateFromInput);
    setDateTo(dateToInput);
  };

  const clearFilters = (): void => {
    setSearchInput("");
    setSearch("");
    setStatusFilter("all");
    setDateFromInput("");
    setDateToInput("");
    setDateFrom("");
    setDateTo("");
    setFilterError(null);
    setPage(1);
  };

  const columns = useMemo<
    DataTableColumn<DispatchRecord>[]
  >(
    () => [
      {
        key: "dispatch_number",
        header: "Dispatch",
        render: (dispatch) => (
          <div>
            <p className="font-semibold text-text-primary">
              {dispatch.dispatch_number}
            </p>

            <p className="mt-1 text-xs text-text-muted">
              {formatDate(
                dispatch.dispatch_date,
              )}
            </p>
          </div>
        ),
      },
      {
        key: "customer",
        header: "Customer",
        render: (dispatch) => (
          <div>
            <p className="font-medium text-text-primary">
              {dispatch.customer_name}
            </p>

            {dispatch.sales_order_number && (
              <p className="mt-1 text-xs text-text-muted">
                Order:{" "}
                {dispatch.sales_order_number}
              </p>
            )}
          </div>
        ),
      },
      {
        key: "invoice",
        header: "Invoice",
        render: (dispatch) =>
          dispatch.invoice_id ? (
            <Link
              to={`/invoices/${encodeURIComponent(dispatch.invoice_id)}`}
              className="text-accent hover:underline"
            >
              {dispatch.invoice_number ??
                dispatch.invoice_id}
            </Link>
          ) : (
            <span className="text-text-muted">
              Not linked
            </span>
          ),
      },
      {
        key: "items",
        header: "Batch lines",
        numeric: true,
        render: (dispatch) => (
          <span className="app-numeric">
            {dispatch.items.length}
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (dispatch) => (
          <StatusBadge
            status={dispatch.status}
            category="transaction"
            showDot
          />
        ),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (dispatch) => (
          <div className="flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() =>
                setDetailsTarget(dispatch)
              }
              className="text-sm font-medium text-accent hover:underline"
            >
              Details
            </button>

            {canManage &&
              dispatch.status === "draft" && (
                <button
                  type="button"
                  onClick={() =>
                    openPost(dispatch)
                  }
                  disabled={
                    !isOnline ||
                    posting ||
                    creating
                  }
                  className="text-sm font-medium text-success hover:underline disabled:opacity-50"
                >
                  Post
                </button>
              )}
          </div>
        ),
      },
    ],
    [canManage, isOnline, posting, creating],
  );

  if (!canAccess) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Dispatch Management
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Dispatch access is restricted to
          authorized operational and reporting roles.
        </div>

        <Link
          to="/dashboard"
          className="app-button app-button-secondary"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="app-page space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Truck
              size={27}
              className="text-primary"
              aria-hidden="true"
            />

            <h2 className="app-page-title">
              Dispatch Management
            </h2>
          </div>

          <p className="app-page-description">
            Record finished-product dispatches,
            select traceable stock batches, and
            review backend-posted inventory movements.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void loadDispatches();
            }}
            disabled={loading || creating || posting}
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

          {canManage && (
            <button
              type="button"
              onClick={openCreate}
              disabled={
                !isOnline ||
                creating ||
                posting
              }
              className="app-button app-button-primary inline-flex items-center gap-2"
            >
              <Plus
                size={17}
                aria-hidden="true"
              />
              New dispatch
            </button>
          )}
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
            The device is offline. Dispatch creation,
            posting, stock validation, and batch
            allocation require a backend connection.
            Dispatch operations are not queued offline.
          </p>
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

      <section className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <ClipboardCheck
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Dispatch controls
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Dispatches must reference eligible
              approved sales orders and available
              finished-product batches. Batches are
              displayed by earliest expiry date.
              The backend revalidates FEFO allocation,
              remaining order quantities, batch expiry,
              available stock, and duplicate submissions
              when posting. Invoice creation and
              payment collection are separate workflows.
            </p>
          </div>
        </div>
      </section>

      <section className="app-card space-y-5">
        <div>
          <h3 className="text-base font-semibold text-text-primary">
            Dispatch register
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            Review recorded dispatches and their
            posting status.
          </p>
        </div>

        <form
          onSubmit={handleFilterSubmit}
          className="space-y-4"
        >
          {filterError && (
            <div
              role="alert"
              className="app-alert app-alert-error"
            >
              {filterError}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <label
                htmlFor="dispatch-search"
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
                  id="dispatch-search"
                  type="search"
                  value={searchInput}
                  onChange={(event) =>
                    setSearchInput(event.target.value)
                  }
                  placeholder="Dispatch, order, customer..."
                  className="app-input w-full pl-10"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="dispatch-status"
                className="app-field-label mb-2 block"
              >
                Status
              </label>

              <select
                id="dispatch-status"
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(
                    event.target.value as DispatchStatusFilter,
                  );
                  setPage(1);
                }}
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

            <div>
              <label
                htmlFor="dispatch-date-from"
                className="app-field-label mb-2 block"
              >
                Date from
              </label>

              <input
                id="dispatch-date-from"
                type="date"
                value={dateFromInput}
                onChange={(event) =>
                  setDateFromInput(event.target.value)
                }
                className="app-input w-full"
              />
            </div>

            <div>
              <label
                htmlFor="dispatch-date-to"
                className="app-field-label mb-2 block"
              >
                Date to
              </label>

              <input
                id="dispatch-date-to"
                type="date"
                value={dateToInput}
                onChange={(event) =>
                  setDateToInput(event.target.value)
                }
                className="app-input w-full"
              />
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={clearFilters}
              className="app-button app-button-secondary inline-flex items-center gap-2"
            >
              <FilterX
                size={16}
                aria-hidden="true"
              />
              Clear filters
            </button>

            <button
              type="submit"
              className="app-button app-button-primary"
            >
              Apply filters
            </button>
          </div>
        </form>

        {loading && dispatches.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading dispatches..."
          />
        ) : (
          <DataTable<DispatchRecord>
            columns={columns}
            data={dispatches}
            getRowId={(dispatch) => dispatch.id}
            loading={loading}
            error={error}
            onRetry={() => loadDispatches()}
            emptyMessage="No dispatches found"
            emptyDescription="No dispatch records match the selected filters."
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="dispatch-register-table"
          />
        )}
      </section>

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-5">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-dispatch-title"
            className="flex max-h-[95vh] w-full max-w-5xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-xl"
          >
            <header className="flex items-start justify-between gap-4 border-b border-border p-5">
              <div>
                <h3
                  id="create-dispatch-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  Create dispatch
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Select an eligible order and
                  allocate finished-product batches.
                </p>
              </div>

              <button
                type="button"
                onClick={closeCreate}
                disabled={creating}
                aria-label="Close dispatch form"
                className="rounded-control p-2 text-text-muted hover:bg-background"
              >
                <X
                  size={20}
                  aria-hidden="true"
                />
              </button>
            </header>

            <form
              onSubmit={(event) => {
                void submitCreate(event);
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
                {formError && (
                  <div
                    role="alert"
                    className="app-alert app-alert-error"
                  >
                    <p>{formError}</p>

                    <p className="mt-2 text-xs">
                      If a network response was
                      interrupted, check the dispatch
                      register before retrying.
                    </p>
                  </div>
                )}

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label
                      htmlFor="dispatch-order"
                      className="app-field-label mb-2 block"
                    >
                      Approved sales order *
                    </label>

                    <select
                      id="dispatch-order"
                      value={form.sales_order_id}
                      onChange={(event) => {
                        void selectOrder(
                          event.target.value,
                        );
                      }}
                      required
                      disabled={
                        creating ||
                        ordersLoading ||
                        orderLoading
                      }
                      className="app-select w-full"
                    >
                      <option value="">
                        Select eligible order
                      </option>

                      {eligibleOrders.map((order) => (
                        <option
                          key={order.id}
                          value={order.id}
                        >
                          {order.order_number} —{" "}
                          {order.customer_name}
                        </option>
                      ))}
                    </select>

                    {ordersLoading && (
                      <p className="app-field-help mt-2">
                        Loading eligible orders...
                      </p>
                    )}

                    {!ordersLoading &&
                      eligibleOrders.length === 0 && (
                        <p className="app-field-help mt-2">
                          No eligible orders were
                          returned in the current
                          selection.
                        </p>
                      )}
                  </div>

                  <div>
                    <label
                      htmlFor="dispatch-date"
                      className="app-field-label mb-2 block"
                    >
                      Dispatch date *
                    </label>

                    <input
                      id="dispatch-date"
                      type="date"
                      value={form.dispatch_date}
                      onChange={(event) =>
                        updateFormField(
                          "dispatch_date",
                          event.target.value,
                        )
                      }
                      required
                      disabled={creating}
                      className="app-input w-full"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="dispatch-vehicle"
                      className="app-field-label mb-2 block"
                    >
                      Vehicle number
                    </label>

                    <input
                      id="dispatch-vehicle"
                      type="text"
                      value={form.vehicle_number}
                      onChange={(event) =>
                        updateFormField(
                          "vehicle_number",
                          event.target.value,
                        )
                      }
                      maxLength={50}
                      disabled={creating}
                      className="app-input w-full"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="dispatch-transporter"
                      className="app-field-label mb-2 block"
                    >
                      Transporter
                    </label>

                    <input
                      id="dispatch-transporter"
                      type="text"
                      value={form.transporter_name}
                      onChange={(event) =>
                        updateFormField(
                          "transporter_name",
                          event.target.value,
                        )
                      }
                      maxLength={150}
                      disabled={creating}
                      className="app-input w-full"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label
                      htmlFor="dispatch-reference"
                      className="app-field-label mb-2 block"
                    >
                      Transport reference
                    </label>

                    <input
                      id="dispatch-reference"
                      type="text"
                      value={form.reference_number}
                      onChange={(event) =>
                        updateFormField(
                          "reference_number",
                          event.target.value,
                        )
                      }
                      maxLength={100}
                      disabled={creating}
                      className="app-input w-full"
                    />
                  </div>
                </div>

                {selectedOrder && (
                  <div className="rounded-control border border-border bg-background p-4 text-sm">
                    <p className="font-semibold text-text-primary">
                      {selectedOrder.customer_name}
                    </p>

                    <p className="mt-1 text-text-muted">
                      Order:{" "}
                      {selectedOrder.order_number}
                    </p>

                    {selectedOrder.invoice_id && (
                      <Link
                        to={`/invoices/${encodeURIComponent(selectedOrder.invoice_id)}`}
                        className="mt-2 inline-block text-accent hover:underline"
                      >
                        Invoice:{" "}
                        {selectedOrder.invoice_number ??
                          selectedOrder.invoice_id}
                      </Link>
                    )}
                  </div>
                )}

                {(orderLoading || batchesLoading) && (
                  <LoadingState
                    variant="section"
                    message="Loading order quantities and available batches..."
                  />
                )}

                {selectedOrder &&
                  !orderLoading &&
                  !batchesLoading && (
                    <section className="space-y-4">
                      <div>
                        <h4 className="font-semibold text-text-primary">
                          Batch allocation
                        </h4>

                        <p className="mt-1 text-sm text-text-muted">
                          Enter quantities against
                          available batches. The
                          earliest-expiring batch
                          appears first.
                        </p>
                      </div>

                      {form.lines.map((line) => {
                        const batches =
                          batchOptions[
                            line.product_id
                          ] ?? [];

                        const selectedBatch =
                          batches.find(
                            (batch) =>
                              batch.id ===
                              line.batch_id,
                          );

                        return (
                          <div
                            key={line.client_id}
                            className="rounded-control border border-border p-4"
                          >
                            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <h5 className="font-semibold text-text-primary">
                                  {line.product_name}
                                </h5>

                                <p className="mt-1 text-xs text-text-muted">
                                  Remaining order
                                  quantity:{" "}
                                  {formatQuantity(
                                    line.remaining_quantity,
                                  )}{" "}
                                  {line.unit}
                                </p>
                              </div>

                              <Package
                                size={20}
                                className="text-secondary"
                                aria-hidden="true"
                              />
                            </div>

                            <div className="grid gap-4 md:grid-cols-2">
                              <div>
                                <label
                                  htmlFor={`dispatch-batch-${line.client_id}`}
                                  className="app-field-label mb-2 block"
                                >
                                  Stock batch
                                </label>

                                <select
                                  id={`dispatch-batch-${line.client_id}`}
                                  value={line.batch_id}
                                  onChange={(event) =>
                                    updateLine(
                                      line.client_id,
                                      "batch_id",
                                      event.target.value,
                                    )
                                  }
                                  disabled={
                                    creating ||
                                    batches.length === 0
                                  }
                                  className="app-select w-full"
                                >
                                  <option value="">
                                    Select batch
                                  </option>

                                  {batches.map(
                                    (batch) => (
                                      <option
                                        key={batch.id}
                                        value={batch.id}
                                      >
                                        {
                                          batch.batch_number
                                        }
                                        {" — "}
                                        {formatQuantity(
                                          batch.available_quantity,
                                        )}{" "}
                                        {batch.unit}
                                        {batch.expiry_date
                                          ? ` — Exp ${formatDate(batch.expiry_date)}`
                                          : ""}
                                      </option>
                                    ),
                                  )}
                                </select>

                                {batches.length === 0 && (
                                  <p className="app-field-help mt-2">
                                    No available batches
                                    were returned for
                                    this product.
                                  </p>
                                )}
                              </div>

                              <div>
                                <label
                                  htmlFor={`dispatch-quantity-${line.client_id}`}
                                  className="app-field-label mb-2 block"
                                >
                                  Dispatch quantity
                                </label>

                                <input
                                  id={`dispatch-quantity-${line.client_id}`}
                                  type="text"
                                  inputMode="decimal"
                                  value={line.quantity}
                                  onChange={(event) =>
                                    updateLine(
                                      line.client_id,
                                      "quantity",
                                      event.target.value,
                                    )
                                  }
                                  disabled={creating}
                                  placeholder="0"
                                  className="app-input w-full"
                                />

                                {selectedBatch && (
                                  <p className="app-field-help mt-2">
                                    Cached batch
                                    availability:{" "}
                                    {formatQuantity(
                                      selectedBatch.available_quantity,
                                    )}{" "}
                                    {selectedBatch.unit}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </section>
                  )}

                <div>
                  <label
                    htmlFor="dispatch-notes"
                    className="app-field-label mb-2 block"
                  >
                    Notes
                  </label>

                  <textarea
                    id="dispatch-notes"
                    value={form.notes}
                    onChange={(event) =>
                      updateFormField(
                        "notes",
                        event.target.value,
                      )
                    }
                    rows={3}
                    maxLength={MAX_NOTES_LENGTH}
                    disabled={creating}
                    className="app-textarea w-full"
                  />
                </div>

                <div className="rounded-control border border-border bg-background p-4 text-xs leading-5 text-text-muted">
                  Batch availability is a snapshot.
                  The backend must revalidate stock,
                  expiry dates, FEFO rules, order
                  balances, and concurrent allocations.
                  Creating a draft does not deduct
                  stock. Posting performs authoritative
                  inventory movements.
                </div>
              </div>

              <footer className="flex flex-wrap justify-end gap-3 border-t border-border p-5">
                <button
                  type="button"
                  onClick={closeCreate}
                  disabled={creating}
                  className="app-button app-button-secondary"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={
                    creating ||
                    !isOnline ||
                    !selectedOrder ||
                    orderLoading ||
                    batchesLoading
                  }
                  className="app-button app-button-primary inline-flex items-center gap-2"
                >
                  <Plus
                    size={17}
                    aria-hidden="true"
                  />
                  {creating
                    ? "Creating..."
                    : "Create draft dispatch"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {detailsTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="dispatch-details-title"
            className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-xl"
          >
            <header className="flex items-start justify-between gap-4 border-b border-border p-5">
              <div>
                <h3
                  id="dispatch-details-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  Dispatch{" "}
                  {detailsTarget.dispatch_number}
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  {detailsTarget.customer_name}
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  setDetailsTarget(null)
                }
                aria-label="Close dispatch details"
                className="rounded-control p-2 text-text-muted hover:bg-background"
              >
                <X
                  size={20}
                  aria-hidden="true"
                />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              <StatusBadge
                status={detailsTarget.status}
                category="transaction"
                showDot
              />

              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-text-muted">
                    Dispatch date
                  </dt>

                  <dd className="mt-1 font-medium">
                    {formatDate(
                      detailsTarget.dispatch_date,
                    )}
                  </dd>
                </div>

                <div>
                  <dt className="text-text-muted">
                    Sales order
                  </dt>

                  <dd className="mt-1 font-medium">
                    {detailsTarget.sales_order_number ??
                      detailsTarget.sales_order_id}
                  </dd>
                </div>

                <div>
                  <dt className="text-text-muted">
                    Vehicle
                  </dt>

                  <dd className="mt-1 font-medium">
                    {detailsTarget.vehicle_number ??
                      "Not recorded"}
                  </dd>
                </div>

                <div>
                  <dt className="text-text-muted">
                    Transporter
                  </dt>

                  <dd className="mt-1 font-medium">
                    {detailsTarget.transporter_name ??
                      "Not recorded"}
                  </dd>
                </div>

                <div>
                  <dt className="text-text-muted">
                    Reference
                  </dt>

                  <dd className="mt-1 font-medium">
                    {detailsTarget.reference_number ??
                      "Not recorded"}
                  </dd>
                </div>

                <div>
                  <dt className="text-text-muted">
                    Posted at
                  </dt>

                  <dd className="mt-1 font-medium">
                    {detailsTarget.posted_at
                      ? formatDateTime(
                          detailsTarget.posted_at,
                        )
                      : "Not posted"}
                  </dd>
                </div>
              </dl>

              <div className="app-table-container">
                <table className="app-table w-full">
                  <thead>
                    <tr>
                      <th scope="col">Product</th>
                      <th scope="col">Batch</th>
                      <th scope="col">Expiry</th>
                      <th
                        scope="col"
                        className="text-right"
                      >
                        Quantity
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {detailsTarget.items.map(
                      (item) => (
                        <tr key={item.id}>
                          <td>
                            {item.product_name}
                          </td>

                          <td>
                            {item.batch_number}
                          </td>

                          <td>
                            {item.expiry_date
                              ? formatDate(
                                  item.expiry_date,
                                )
                              : "Not recorded"}
                          </td>

                          <td className="app-numeric whitespace-nowrap text-right">
                            {formatQuantity(
                              item.quantity,
                            )}{" "}
                            {item.unit}
                          </td>
                        </tr>
                      ),
                    )}

                    {detailsTarget.items.length ===
                      0 && (
                      <tr>
                        <td
                          colSpan={4}
                          className="py-6 text-center text-text-muted"
                        >
                          No dispatch lines returned.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {detailsTarget.notes && (
                <div>
                  <h4 className="text-sm font-semibold text-text-primary">
                    Notes
                  </h4>

                  <p className="mt-2 whitespace-pre-wrap text-sm text-text-muted">
                    {detailsTarget.notes}
                  </p>
                </div>
              )}
            </div>

            <footer className="flex justify-end border-t border-border p-5">
              <button
                type="button"
                onClick={() =>
                  setDetailsTarget(null)
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
        open={postTarget !== null}
        title="Post dispatch"
        message={
          postTarget
            ? `Post dispatch ${postTarget.dispatch_number}?`
            : ""
        }
        description="Posting is a stock-affecting transaction. The backend must atomically validate batch availability, expiry, FEFO allocation, remaining order quantities, and duplicate requests before recording stock movements."
        variant="warning"
        confirmLabel="Post dispatch"
        cancelLabel="Cancel"
        isLoading={posting}
        onCancel={closePost}
        onConfirm={submitPost}
      >
        {postTarget && (
          <div className="space-y-2 rounded-control border border-border p-4 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-text-muted">
                Customer
              </span>

              <span className="text-right font-medium">
                {postTarget.customer_name}
              </span>
            </div>

            <div className="flex justify-between gap-4">
              <span className="text-text-muted">
                Dispatch lines
              </span>

              <span className="app-numeric font-medium">
                {postTarget.items.length}
              </span>
            </div>
          </div>
        )}

        {postError && (
          <div
            role="alert"
            className="app-alert app-alert-error"
          >
            <div className="flex items-start gap-2">
              <AlertCircle
                size={18}
                className="shrink-0"
                aria-hidden="true"
              />

              <div>
                <p>{postError}</p>

                <p className="mt-2 text-xs">
                  If the response was interrupted,
                  verify the dispatch status before
                  retrying.
                </p>
              </div>
            </div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

export default DispatchPage;