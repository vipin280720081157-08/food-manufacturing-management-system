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
  ArrowDownLeft,
  ArrowUpRight,
  ClipboardList,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";

import { Link } from "react-router-dom";

import type {
  InventoryItem,
  PaginatedResponse,
  TransactionStatus,
  UnitOfMeasure,
  UUID,
} from "../../types/business";

import { USER_ROLES } from "../../types/auth";
import { useAuth } from "../../hooks/useAuth";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";

import {
  apiClient,
  getApiErrorMessage,
} from "../../services/api/client";

import { getInventoryItems } from "../../services/api/mastersApi";

import {
  DataTable,
  type DataTableColumn,
} from "../../components/tables/DataTable";

import { LoadingState } from "../../components/common/LoadingState";
import { StatusBadge } from "../../components/common/StatusBadge";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";

import {
  formatDateTime,
  formatQuantity,
} from "../../utils/formatters";

const PAGE_SIZE = 20;
const ITEM_PAGE_SIZE = 100;

type AdjustmentDirection = "increase" | "decrease";

type AdjustmentStatusFilter =
  | "all"
  | TransactionStatus;

interface StockAdjustment {
  id: UUID;
  adjustment_number: string;
  item_id: UUID;
  item_code: string;
  item_name: string;
  batch_id: UUID | null;
  batch_number: string | null;
  direction: AdjustmentDirection;
  quantity: string;
  unit: UnitOfMeasure;
  reason: string;
  notes: string | null;
  status: TransactionStatus;
  adjustment_date: string;
  created_at: string;
  created_by: UUID | null;
  posted_at: string | null;
  posted_by: UUID | null;
}

interface StockAdjustmentInput {
  item_id: UUID;
  batch_id: UUID | null;
  direction: AdjustmentDirection;
  quantity: string;
  unit: UnitOfMeasure;
  reason: string;
  notes: string | null;
}

interface StockAdjustmentFilters {
  page: number;
  search: string;
  status: AdjustmentStatusFilter;
}

interface StockAdjustmentForm {
  item_id: string;
  batch_id: string;
  direction: AdjustmentDirection;
  quantity: string;
  reason: string;
  notes: string;
}

interface StockBatchOption {
  id: UUID;
  batch_number: string;
  item_id: UUID;
  quantity_available: string;
  base_unit: UnitOfMeasure;
}

type StockBatchOptionsResponse = PaginatedResponse<StockBatchOption>;

const EMPTY_FORM: StockAdjustmentForm = {
  item_id: "",
  batch_id: "",
  direction: "increase",
  quantity: "",
  reason: "",
  notes: "",
};

const ADJUSTMENT_REASONS = [
  "Physical stock count correction",
  "Damage or wastage",
  "Expiry or spoilage",
  "Stock reconciliation",
  "Other documented reason",
] as const;

function isPositiveDecimal(value: string): boolean {
  const normalized = value.trim();

  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return false;
  }

  const digits = normalized.replace(".", "");

  return /[1-9]/.test(digits);
}

function getAdjustmentDirectionLabel(
  direction: AdjustmentDirection,
): string {
  return direction === "increase"
    ? "Stock increase"
    : "Stock decrease";
}

function formatSignedQuantity(
  adjustment: StockAdjustment,
): string {
  const prefix =
    adjustment.direction === "increase" ? "+" : "−";

  return `${prefix}${formatQuantity(
    adjustment.quantity,
  )} ${adjustment.unit}`;
}

function formatAdjustmentStatus(
  status: TransactionStatus,
): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "posted":
      return "Posted";
    case "cancelled":
      return "Cancelled";
  }
}

async function fetchAdjustments(
  filters: StockAdjustmentFilters,
  signal?: AbortSignal,
): Promise<PaginatedResponse<StockAdjustment>> {
  return apiClient.get<PaginatedResponse<StockAdjustment>>(
    "/inventory/adjustments",
    {
      query: {
        page: filters.page,
        page_size: PAGE_SIZE,
        search: filters.search || undefined,
        status:
          filters.status === "all"
            ? undefined
            : filters.status,
      },
      signal,
    },
  );
}

async function fetchBatchOptions(
  itemId: UUID,
  signal?: AbortSignal,
): Promise<StockBatchOption[]> {
  const response =
    await apiClient.get<StockBatchOptionsResponse>(
      "/inventory/batches",
      {
        query: {
          item_id: itemId,
          page: 1,
          page_size: ITEM_PAGE_SIZE,
        },
        signal,
      },
    );

  return response.items.filter(
    (batch) => batch.item_id === itemId,
  );
}

async function createStockAdjustment(
  payload: StockAdjustmentInput,
  idempotencyKey: string,
): Promise<StockAdjustment> {
  return apiClient.post<StockAdjustment>(
    "/inventory/adjustments",
    payload,
    { idempotencyKey },
  );
}

async function postStockAdjustment(
  adjustmentId: UUID,
  idempotencyKey: string,
): Promise<StockAdjustment> {
  return apiClient.post<StockAdjustment>(
    `/inventory/adjustments/${encodeURIComponent(
      adjustmentId,
    )}/post`,
    undefined,
    { idempotencyKey },
  );
}

function StockAdjustmentDetails({
  adjustment,
  onClose,
}: {
  adjustment: StockAdjustment;
  onClose: () => void;
}) {
  const details: Array<{
    label: string;
    value: string;
  }> = [
    {
      label: "Adjustment number",
      value: adjustment.adjustment_number,
    },
    {
      label: "Status",
      value: formatAdjustmentStatus(adjustment.status),
    },
    {
      label: "Adjustment date",
      value: formatDateTime(adjustment.adjustment_date),
    },
    {
      label: "Inventory item",
      value: adjustment.item_name,
    },
    {
      label: "Item code",
      value: adjustment.item_code,
    },
    {
      label: "Batch number",
      value: adjustment.batch_number ?? "—",
    },
    {
      label: "Batch reference",
      value: adjustment.batch_id ?? "—",
    },
    {
      label: "Direction",
      value: getAdjustmentDirectionLabel(
        adjustment.direction,
      ),
    },
    {
      label: "Quantity",
      value: formatSignedQuantity(adjustment),
    },
    {
      label: "Reason",
      value: adjustment.reason,
    },
    {
      label: "Created at",
      value: formatDateTime(adjustment.created_at),
    },
    {
      label: "Created by",
      value: adjustment.created_by ?? "—",
    },
    {
      label: "Posted at",
      value: adjustment.posted_at
        ? formatDateTime(adjustment.posted_at)
        : "Not posted",
    },
    {
      label: "Posted by",
      value: adjustment.posted_by ?? "—",
    },
    {
      label: "Adjustment reference",
      value: adjustment.id,
    },
  ];

  return (
    <div className="space-y-5">
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {details.map((detail) => (
          <div
            key={detail.label}
            className="min-w-0 border-b border-border pb-3"
          >
            <dt className="text-xs font-medium text-text-muted">
              {detail.label}
            </dt>

            <dd className="mt-1 break-words text-sm font-medium text-text-primary">
              {detail.value}
            </dd>
          </div>
        ))}
      </dl>

      {adjustment.notes && (
        <div>
          <h4 className="text-sm font-semibold text-text-primary">
            Notes
          </h4>

          <p className="mt-2 whitespace-pre-wrap rounded-control bg-background p-3 text-sm text-text-muted">
            {adjustment.notes}
          </p>
        </div>
      )}

      <div className="rounded-control border border-border bg-background p-4">
        <p className="text-xs leading-5 text-text-muted">
          Draft adjustments do not change inventory.
          Posting is performed by the backend and
          must atomically validate stock balances,
          update inventory, and record an auditable
          stock movement.
        </p>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="app-button app-button-secondary"
        >
          Close
        </button>
      </div>
    </div>
  );
}

export function StockAdjustmentsPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canViewAdjustments =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.PRODUCTION_SUPERVISOR ||
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const canManageAdjustments =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [adjustments, setAdjustments] =
    useState<StockAdjustment[]>([]);

  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [statusFilter, setStatusFilter] =
    useState<AdjustmentStatusFilter>("all");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] =
    useState<StockAdjustmentForm>(EMPTY_FORM);

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] =
    useState<string | null>(null);

  const [batchOptions, setBatchOptions] =
    useState<StockBatchOption[]>([]);

  const [batchesLoading, setBatchesLoading] =
    useState(false);

  const [batchesError, setBatchesError] =
    useState<string | null>(null);

  const [formError, setFormError] =
    useState<string | null>(null);

  const [saving, setSaving] = useState(false);

  const [selectedAdjustment, setSelectedAdjustment] =
    useState<StockAdjustment | null>(null);

  const [postingAdjustment, setPostingAdjustment] =
    useState<StockAdjustment | null>(null);

  const [posting, setPosting] = useState(false);

  const [actionError, setActionError] =
    useState<string | null>(null);

  const [successMessage, setSuccessMessage] =
    useState<string | null>(null);

  const createKeyRef = useRef<string | null>(null);
  const postKeysRef = useRef<Map<UUID, string>>(new Map());
  const formDialogRef = useRef<HTMLDivElement>(null);
  const detailsDialogRef = useRef<HTMLDivElement>(null);

  const filters = useMemo<StockAdjustmentFilters>(
    () => ({
      page,
      search,
      status: statusFilter,
    }),
    [page, search, statusFilter],
  );

  const selectedItem = useMemo(
    () => items.find((item) => item.id === form.item_id),
    [items, form.item_id],
  );

  const loadAdjustments = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canViewAdjustments) {
        setAdjustments([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchAdjustments(
          filters,
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setAdjustments(response.items);
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
    [canViewAdjustments, filters],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadAdjustments(controller.signal);

    return () => controller.abort();
  }, [loadAdjustments]);

  useEffect(() => {
    if (!formOpen || !canManageAdjustments) {
      return;
    }

    const controller = new AbortController();

    const loadItems = async (): Promise<void> => {
      setItemsLoading(true);
      setItemsError(null);

      try {
        const collected: InventoryItem[] = [];
        let currentPage = 1;
        let totalItems = 0;

        do {
          const response = await getInventoryItems(
            {
              page: currentPage,
              page_size: ITEM_PAGE_SIZE,
            },
            { signal: controller.signal },
          );

          if (controller.signal.aborted) {
            return;
          }

          collected.push(...response.items);
          totalItems = response.total;
          currentPage += 1;

          if (response.items.length === 0) {
            break;
          }
        } while (collected.length < totalItems);

        if (!controller.signal.aborted) {
          setItems(
            collected.filter((item) => item.is_active),
          );
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setItemsError(getApiErrorMessage(failure));
        }
      } finally {
        if (!controller.signal.aborted) {
          setItemsLoading(false);
        }
      }
    };

    void loadItems();

    return () => controller.abort();
  }, [formOpen, canManageAdjustments]);

  useEffect(() => {
    if (!formOpen || !form.item_id) {
      setBatchOptions([]);
      setBatchesError(null);
      return;
    }

    const controller = new AbortController();

    const loadBatches = async (): Promise<void> => {
      setBatchesLoading(true);
      setBatchesError(null);

      try {
        const response = await fetchBatchOptions(
          form.item_id,
          controller.signal,
        );

        if (!controller.signal.aborted) {
          setBatchOptions(response);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setBatchesError(getApiErrorMessage(failure));
        }
      } finally {
        if (!controller.signal.aborted) {
          setBatchesLoading(false);
        }
      }
    };

    void loadBatches();

    return () => controller.abort();
  }, [formOpen, form.item_id]);

  useEffect(() => {
    const dialog = formOpen
      ? formDialogRef.current
      : selectedAdjustment
        ? detailsDialogRef.current
        : null;

    if (!dialog) {
      return;
    }

    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const focusable = dialog.querySelector<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex='0']",
    );

    focusable?.focus();

    const handleKeyDown = (
      event: KeyboardEvent,
    ): void => {
      if (event.key === "Escape") {
        if (formOpen && !saving) {
          setFormOpen(false);
        } else if (selectedAdjustment) {
          setSelectedAdjustment(null);
        }
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const elements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex='0']",
        ),
      );

      const first = elements[0];
      const last = elements[elements.length - 1];

      if (!first || !last) {
        return;
      }

      if (
        event.shiftKey &&
        document.activeElement === first
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === last
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener(
        "keydown",
        handleKeyDown,
      );
      previousFocus?.focus();
    };
  }, [formOpen, selectedAdjustment, saving]);

  const openCreateForm = (): void => {
    if (!canManageAdjustments || !isOnline) {
      return;
    }

    setForm(EMPTY_FORM);
    setFormError(null);
    setActionError(null);
    setSuccessMessage(null);
    setBatchOptions([]);
    createKeyRef.current = null;
    setFormOpen(true);
  };

  const closeCreateForm = (): void => {
    if (!saving) {
      setFormOpen(false);
    }
  };

  const updateForm = <K extends keyof StockAdjustmentForm>(
    field: K,
    value: StockAdjustmentForm[K],
  ): void => {
    createKeyRef.current = null;
    setFormError(null);

    setForm((current) => ({
      ...current,
      [field]: value,
      ...(field === "item_id" ? { batch_id: "" } : {}),
    }));
  };

  const validateForm = (): string | null => {
    if (!selectedItem) {
      return "Select a valid inventory item.";
    }

    if (!isPositiveDecimal(form.quantity)) {
      return "Quantity must be a positive decimal number.";
    }

    if (!form.reason.trim()) {
      return "Select an adjustment reason.";
    }

    if (
      !ADJUSTMENT_REASONS.includes(
        form.reason as (typeof ADJUSTMENT_REASONS)[number],
      )
    ) {
      return "Select a valid adjustment reason.";
    }

    if (
      form.reason === "Other documented reason" &&
      !form.notes.trim()
    ) {
      return "Provide an explanation for the adjustment.";
    }

    if (
      form.batch_id &&
      !batchOptions.some(
        (batch) => batch.id === form.batch_id,
      )
    ) {
      return "Select a valid batch for the inventory item.";
    }

    if (batchesLoading || batchesError) {
      return "Batch information must be loaded before creating an adjustment.";
    }

    return null;
  };

  const handleCreate = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (saving || !canManageAdjustments || !isOnline) {
      return;
    }

    const validationError = validateForm();

    if (validationError) {
      setFormError(validationError);
      return;
    }

    if (!selectedItem) {
      return;
    }

    const idempotencyKey =
      createKeyRef.current ?? crypto.randomUUID();

    createKeyRef.current = idempotencyKey;

    setSaving(true);
    setFormError(null);

    try {
      const created = await createStockAdjustment(
        {
          item_id: selectedItem.id,
          batch_id: form.batch_id || null,
          direction: form.direction,
          quantity: form.quantity.trim(),
          unit: selectedItem.base_unit,
          reason: form.reason,
          notes: form.notes.trim() || null,
        },
        idempotencyKey,
      );

      createKeyRef.current = null;
      setFormOpen(false);
      setSuccessMessage(
        `Adjustment ${created.adjustment_number} was created as ${created.status}.`,
      );

      setPage(1);
      await loadAdjustments();
    } catch (failure) {
      setFormError(getApiErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  const handlePost = async (): Promise<void> => {
    if (
      !postingAdjustment ||
      posting ||
      !canManageAdjustments ||
      !isOnline
    ) {
      return;
    }

    const adjustment = postingAdjustment;

    const existingKey = postKeysRef.current.get(
      adjustment.id,
    );

    const idempotencyKey =
      existingKey ?? crypto.randomUUID();

    postKeysRef.current.set(
      adjustment.id,
      idempotencyKey,
    );

    setPosting(true);
    setActionError(null);
    setSuccessMessage(null);

    try {
      const result = await postStockAdjustment(
        adjustment.id,
        idempotencyKey,
      );

      postKeysRef.current.delete(adjustment.id);
      setPostingAdjustment(null);

      setSuccessMessage(
        `Adjustment ${result.adjustment_number} was ${result.status}.`,
      );

      await loadAdjustments();
    } catch (failure) {
      setActionError(getApiErrorMessage(failure));
      setPostingAdjustment(null);

      await loadAdjustments();
    } finally {
      setPosting(false);
    }
  };

  const handleSearch = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  };

  const columns = useMemo<
    DataTableColumn<StockAdjustment>[]
  >(
    () => [
      {
        key: "adjustment_number",
        header: "Adjustment",
        render: (adjustment) => (
          <button
            type="button"
            onClick={() =>
              setSelectedAdjustment(adjustment)
            }
            className="text-left font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {adjustment.adjustment_number}
          </button>
        ),
      },
      {
        key: "adjustment_date",
        header: "Date",
        render: (adjustment) =>
          formatDateTime(adjustment.adjustment_date),
      },
      {
        key: "item",
        header: "Inventory item",
        render: (adjustment) => (
          <div>
            <p className="font-medium text-text-primary">
              {adjustment.item_name}
            </p>
            <p className="mt-1 text-xs text-text-muted">
              {adjustment.item_code}
            </p>
          </div>
        ),
      },
      {
        key: "batch",
        header: "Batch",
        render: (adjustment) =>
          adjustment.batch_number ?? "—",
        hideOnMobile: true,
      },
      {
        key: "direction",
        header: "Direction",
        render: (adjustment) => (
          <span
            className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
              adjustment.direction === "increase"
                ? "text-success"
                : "text-warning"
            }`}
          >
            {adjustment.direction === "increase" ? (
              <ArrowDownLeft
                size={15}
                aria-hidden="true"
              />
            ) : (
              <ArrowUpRight
                size={15}
                aria-hidden="true"
              />
            )}
            {getAdjustmentDirectionLabel(
              adjustment.direction,
            )}
          </span>
        ),
      },
      {
        key: "quantity",
        header: "Quantity",
        numeric: true,
        render: (adjustment) => (
          <span className="app-numeric whitespace-nowrap font-semibold">
            {formatSignedQuantity(adjustment)}
          </span>
        ),
      },
      {
        key: "reason",
        header: "Reason",
        accessor: "reason",
        hideOnMobile: true,
      },
      {
        key: "status",
        header: "Status",
        render: (adjustment) => (
          <StatusBadge
            status={adjustment.status}
            category="transaction"
            showDot
          />
        ),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (adjustment) =>
          canManageAdjustments &&
          adjustment.status === "draft" ? (
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                setPostingAdjustment(adjustment);
              }}
              disabled={!isOnline || posting}
              className="app-button app-button-secondary text-xs"
              title={
                isOnline
                  ? "Post adjustment"
                  : "Posting requires a connection"
              }
            >
              Post
            </button>
          ) : (
            <span className="text-xs text-text-muted">
              —
            </span>
          ),
      },
    ],
    [canManageAdjustments, isOnline, posting],
  );

  if (!canViewAdjustments) {
    return (
      <div className="app-page space-y-5">
        <div>
          <h2 className="app-page-title">
            Stock Adjustments
          </h2>
          <p className="app-page-description">
            Authorized inventory correction records.
          </p>
        </div>

        <div
          role="alert"
          className="app-alert app-alert-error flex items-start gap-3"
        >
          <AlertCircle
            size={20}
            className="shrink-0"
            aria-hidden="true"
          />
          <div>
            <p className="font-semibold">
              Access restricted
            </p>
            <p className="mt-1">
              Stock adjustment access is not
              available for this role.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-page space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="app-page-title">
            Stock Adjustments
          </h2>

          <p className="app-page-description">
            Record and review controlled inventory
            corrections. Stock balances change only
            when the backend successfully posts an
            authorized adjustment.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void loadAdjustments();
            }}
            disabled={loading}
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

          {canManageAdjustments && (
            <button
              type="button"
              onClick={openCreateForm}
              disabled={!isOnline}
              className="app-button app-button-primary inline-flex items-center gap-2"
            >
              <Plus size={17} aria-hidden="true" />
              New adjustment
            </button>
          )}
        </div>
      </header>

      {!isOnline && (
        <div
          role="status"
          className="app-alert app-alert-warning flex items-start gap-3"
        >
          <AlertCircle
            size={19}
            className="shrink-0"
            aria-hidden="true"
          />
          <p>
            The device is offline. Previously loaded
            records may remain visible, but stock
            adjustments cannot be created or posted
            offline. Offline order capture is a
            separate workflow.
          </p>
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          className="app-alert app-alert-error flex items-start gap-3"
        >
          <AlertCircle
            size={19}
            className="shrink-0"
            aria-hidden="true"
          />
          <div>
            <p>{actionError}</p>
            <p className="mt-1 text-xs">
              Refresh the adjustment status before
              retrying a posting request.
            </p>
          </div>
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          className="app-alert app-alert-success"
        >
          {successMessage}
        </div>
      )}

      <section
        aria-label="Adjustment posting rules"
        className="grid gap-4 md:grid-cols-2"
      >
        <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
          <ClipboardList
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Draft adjustments
            </h3>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              Creating an adjustment records the
              proposed correction and its reason.
              Drafts do not directly modify stock.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
          <ShieldCheck
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Controlled posting
            </h3>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              The backend validates permissions,
              available stock, batch eligibility,
              and transaction consistency before
              recording the movement.
            </p>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="stock-adjustments-heading"
        className="app-card space-y-5"
      >
        <div>
          <h3
            id="stock-adjustments-heading"
            className="text-base font-semibold text-text-primary"
          >
            Adjustment records
          </h3>
          <p className="mt-1 text-sm text-text-muted">
            Search adjustment references and
            inventory items. Posted records remain
            available for audit review.
          </p>
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <form
            onSubmit={handleSearch}
            role="search"
            className="flex min-w-0 flex-1 gap-2"
          >
            <label
              htmlFor="stock-adjustment-search"
              className="app-sr-only"
            >
              Search stock adjustments
            </label>

            <div className="relative min-w-0 flex-1">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />
              <input
                id="stock-adjustment-search"
                type="search"
                value={searchInput}
                onChange={(event) =>
                  setSearchInput(event.target.value)
                }
                placeholder="Search adjustment or item..."
                className="app-input w-full pl-10"
              />
            </div>

            <button
              type="submit"
              className="app-button app-button-secondary"
            >
              Search
            </button>
          </form>

          <div className="w-full lg:w-56">
            <label
              htmlFor="stock-adjustment-status"
              className="app-field-label mb-2 block"
            >
              Status
            </label>

            <select
              id="stock-adjustment-status"
              value={statusFilter}
              onChange={(event) => {
                setPage(1);
                setStatusFilter(
                  event.target
                    .value as AdjustmentStatusFilter,
                );
              }}
              className="app-select w-full"
            >
              <option value="all">
                All statuses
              </option>
              <option value="draft">Draft</option>
              <option value="posted">Posted</option>
              <option value="cancelled">
                Cancelled
              </option>
            </select>
          </div>
        </div>

        {loading && adjustments.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading stock adjustments..."
          />
        ) : (
          <DataTable<StockAdjustment>
            columns={columns}
            data={adjustments}
            getRowId={(adjustment) => adjustment.id}
            loading={loading}
            error={error}
            onRetry={() => loadAdjustments()}
            emptyMessage="No stock adjustments found"
            emptyDescription={
              search || statusFilter !== "all"
                ? "Try changing the search or status filter."
                : "No stock adjustment records are available."
            }
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="stock-adjustments-table"
          />
        )}
      </section>

      <section
        aria-label="Related inventory records"
        className="grid gap-4 md:grid-cols-2"
      >
        <Link
          to="/inventory"
          className="group flex items-start gap-3 rounded-card border border-border bg-surface p-5 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          <ClipboardList
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div>
            <h3 className="text-sm font-semibold text-text-primary group-hover:text-accent">
              Stock summary
            </h3>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              Review backend-calculated inventory
              balances after authorized postings.
            </p>
          </div>
        </Link>

        <Link
          to="/inventory/ledger"
          className="group flex items-start gap-3 rounded-card border border-border bg-surface p-5 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          <ClipboardList
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div>
            <h3 className="text-sm font-semibold text-text-primary group-hover:text-accent">
              Stock ledger
            </h3>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              Trace the stock movements created by
              posted adjustments and other
              inventory transactions.
            </p>
          </div>
        </Link>
      </section>

      {formOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget
            ) {
              closeCreateForm();
            }
          }}
        >
          <div
            ref={formDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-stock-adjustment-title"
            className="flex max-h-[95vh] w-full max-w-2xl flex-col overflow-hidden rounded-card bg-surface shadow-xl"
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="create-stock-adjustment-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  New stock adjustment
                </h3>
                <p className="mt-1 text-sm text-text-muted">
                  Create a draft correction with a
                  documented reason.
                </p>
              </div>

              <button
                type="button"
                onClick={closeCreateForm}
                disabled={saving}
                aria-label="Close adjustment form"
                className="rounded-control p-2 text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </div>

            <form
              onSubmit={(event) => {
                void handleCreate(event);
              }}
              className="min-h-0 overflow-y-auto"
            >
              <div className="space-y-5 px-5 py-5 sm:px-6">
                {formError && (
                  <div
                    role="alert"
                    className="app-alert app-alert-error"
                  >
                    {formError}
                  </div>
                )}

                {itemsError && (
                  <div
                    role="alert"
                    className="app-alert app-alert-error"
                  >
                    {itemsError}
                  </div>
                )}

                <div>
                  <label
                    htmlFor="adjustment-item"
                    className="app-field-label mb-2 block"
                  >
                    Inventory item *
                  </label>

                  <select
                    id="adjustment-item"
                    value={form.item_id}
                    onChange={(event) =>
                      updateForm(
                        "item_id",
                        event.target.value,
                      )
                    }
                    required
                    disabled={saving || itemsLoading}
                    className="app-select w-full"
                  >
                    <option value="">
                      {itemsLoading
                        ? "Loading inventory items..."
                        : "Select an inventory item"}
                    </option>

                    {items.map((item) => (
                      <option
                        key={item.id}
                        value={item.id}
                      >
                        {item.item_code} — {item.name}
                      </option>
                    ))}
                  </select>
                </div>

                {selectedItem && (
                  <p className="text-xs text-text-muted">
                    Base unit:{" "}
                    <strong>
                      {selectedItem.base_unit}
                    </strong>
                  </p>
                )}

                <div>
                  <label
                    htmlFor="adjustment-batch"
                    className="app-field-label mb-2 block"
                  >
                    Stock batch
                  </label>

                  <select
                    id="adjustment-batch"
                    value={form.batch_id}
                    onChange={(event) =>
                      updateForm(
                        "batch_id",
                        event.target.value,
                      )
                    }
                    disabled={
                      saving ||
                      !form.item_id ||
                      batchesLoading ||
                      Boolean(batchesError)
                    }
                    className="app-select w-full"
                  >
                    <option value="">
                      {batchesLoading
                        ? "Loading batches..."
                        : "No specific batch"}
                    </option>

                    {batchOptions.map((batch) => (
                      <option
                        key={batch.id}
                        value={batch.id}
                      >
                        {batch.batch_number} —{" "}
                        {formatQuantity(
                          batch.quantity_available,
                        )}{" "}
                        {batch.base_unit} available
                      </option>
                    ))}
                  </select>

                  <p className="app-field-help mt-1">
                    Batch-level corrections should
                    identify the affected batch.
                    Backend rules determine whether
                    a batch reference is required.
                  </p>

                  {batchesError && (
                    <p
                      role="alert"
                      className="app-field-error mt-1"
                    >
                      {batchesError}
                    </p>
                  )}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="adjustment-direction"
                      className="app-field-label mb-2 block"
                    >
                      Adjustment direction *
                    </label>

                    <select
                      id="adjustment-direction"
                      value={form.direction}
                      onChange={(event) =>
                        updateForm(
                          "direction",
                          event.target
                            .value as AdjustmentDirection,
                        )
                      }
                      disabled={saving}
                      className="app-select w-full"
                    >
                      <option value="increase">
                        Increase stock
                      </option>
                      <option value="decrease">
                        Decrease stock
                      </option>
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="adjustment-quantity"
                      className="app-field-label mb-2 block"
                    >
                      Quantity *
                    </label>

                    <input
                      id="adjustment-quantity"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={form.quantity}
                      onChange={(event) =>
                        updateForm(
                          "quantity",
                          event.target.value,
                        )
                      }
                      placeholder="0.000"
                      required
                      disabled={saving}
                      className="app-input w-full"
                    />

                    <p className="app-field-help mt-1">
                      Enter a positive quantity in
                      the item's base unit.
                    </p>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="adjustment-reason"
                    className="app-field-label mb-2 block"
                  >
                    Reason *
                  </label>

                  <select
                    id="adjustment-reason"
                    value={form.reason}
                    onChange={(event) =>
                      updateForm(
                        "reason",
                        event.target.value,
                      )
                    }
                    required
                    disabled={saving}
                    className="app-select w-full"
                  >
                    <option value="">
                      Select a reason
                    </option>

                    {ADJUSTMENT_REASONS.map(
                      (reason) => (
                        <option
                          key={reason}
                          value={reason}
                        >
                          {reason}
                        </option>
                      ),
                    )}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="adjustment-notes"
                    className="app-field-label mb-2 block"
                  >
                    Supporting notes
                    {form.reason ===
                      "Other documented reason" &&
                      " *"}
                  </label>

                  <textarea
                    id="adjustment-notes"
                    rows={4}
                    maxLength={2000}
                    value={form.notes}
                    onChange={(event) =>
                      updateForm(
                        "notes",
                        event.target.value,
                      )
                    }
                    required={
                      form.reason ===
                      "Other documented reason"
                    }
                    disabled={saving}
                    placeholder="Describe the physical count, discrepancy, damage, or other supporting evidence."
                    className="app-textarea w-full"
                  />
                </div>

                <div className="rounded-control border border-border bg-background p-4">
                  <p className="text-xs leading-5 text-text-muted">
                    Creating this record does not
                    change inventory. The adjustment
                    must be posted separately.
                    Posting is validated and recorded
                    by the backend.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap justify-end gap-3 border-t border-border px-5 py-4 sm:px-6">
                <button
                  type="button"
                  onClick={closeCreateForm}
                  disabled={saving}
                  className="app-button app-button-secondary"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={
                    saving ||
                    itemsLoading ||
                    Boolean(itemsError) ||
                    batchesLoading ||
                    Boolean(batchesError) ||
                    !isOnline
                  }
                  className="app-button app-button-primary"
                >
                  {saving
                    ? "Creating..."
                    : "Create draft"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedAdjustment && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget
            ) {
              setSelectedAdjustment(null);
            }
          }}
        >
          <div
            ref={detailsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="stock-adjustment-details-title"
            className="flex max-h-[95vh] w-full max-w-3xl flex-col overflow-hidden rounded-card bg-surface shadow-xl"
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="stock-adjustment-details-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  Stock adjustment details
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  {
                    selectedAdjustment.adjustment_number
                  }
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  setSelectedAdjustment(null)
                }
                aria-label="Close adjustment details"
                className="rounded-control p-2 text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
              <StockAdjustmentDetails
                adjustment={selectedAdjustment}
                onClose={() =>
                  setSelectedAdjustment(null)
                }
              />
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={postingAdjustment !== null}
        title="Post stock adjustment?"
        message={
          postingAdjustment
            ? `Post adjustment ${postingAdjustment.adjustment_number} for ${postingAdjustment.item_name}?`
            : undefined
        }
        description="Posting may immediately change inventory balances and create an auditable stock movement. This action must be validated by the backend."
        variant="warning"
        confirmLabel="Post adjustment"
        cancelLabel="Cancel"
        isLoading={posting}
        onCancel={() => {
          if (!posting) {
            setPostingAdjustment(null);
          }
        }}
        onConfirm={handlePost}
      />
    </div>
  );
}

export default StockAdjustmentsPage;
