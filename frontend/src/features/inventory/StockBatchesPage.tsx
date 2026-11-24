import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import {
  AlertCircle,
  Boxes,
  CalendarClock,
  ClipboardList,
  Package,
  RefreshCw,
  Search,
} from "lucide-react";

import { Link } from "react-router-dom";

import type {
  InventoryItemType,
  PaginatedResponse,
  UnitOfMeasure,
  UUID,
} from "../../types/business";

import { USER_ROLES } from "../../types/auth";
import { useAuth } from "../../hooks/useAuth";

import {
  apiClient,
  getApiErrorMessage,
} from "../../services/api/client";

import {
  DataTable,
  type DataTableColumn,
} from "../../components/tables/DataTable";

import { LoadingState } from "../../components/common/LoadingState";
import { StatusBadge } from "../../components/common/StatusBadge";

import {
  formatCurrency,
  formatQuantity,
} from "../../utils/formatters";

const PAGE_SIZE = 20;

type BatchItemFilter =
  | "all"
  | "raw_material"
  | "packaging_material"
  | "finished_product";

type BatchStatusFilter =
  | "all"
  | "available"
  | "depleted"
  | "expired";

type BatchAvailabilityStatus =
  | "available"
  | "depleted"
  | "expired";

interface StockBatch {
  id: UUID;
  item_id: UUID;
  item_code: string;
  item_name: string;
  item_type: InventoryItemType;
  batch_number: string;
  manufacturing_date: string | null;
  received_date: string | null;
  expiry_date: string | null;
  base_unit: UnitOfMeasure;
  quantity_received: string;
  quantity_on_hand: string;
  quantity_reserved: string;
  quantity_available: string;
  unit_cost: string;
  stock_value: string;
  source_type: string | null;
  source_id: UUID | null;
  created_at: string;
  updated_at: string | null;
}

interface StockBatchesResponse
  extends PaginatedResponse<StockBatch> {
  as_of?: string;
}

interface StockBatchFilters {
  page: number;
  search: string;
  itemType: BatchItemFilter;
  status: BatchStatusFilter;
}

interface StockBatchDetailsProps {
  batch: StockBatch;
  onClose: () => void;
}

const ITEM_TYPE_LABELS: Record<
  InventoryItemType,
  string
> = {
  raw_material: "Raw material",
  packaging_material: "Packaging material",
  finished_product: "Finished product",
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  goods_receipt: "Goods receipt",
  production: "Production",
  production_run: "Production run",
  stock_adjustment: "Stock adjustment",
  opening_stock: "Opening stock",
};

function isNonnegativeDecimal(
  value: string,
): boolean {
  return /^\d+(?:\.\d+)?$/.test(value);
}

function compareDecimalStrings(
  left: string,
  right: string,
): number | null {
  if (
    !isNonnegativeDecimal(left) ||
    !isNonnegativeDecimal(right)
  ) {
    return null;
  }

  const [leftWhole = "0", leftFraction = ""] =
    left.split(".");

  const [rightWhole = "0", rightFraction = ""] =
    right.split(".");

  const normalizedLeftWhole =
    leftWhole.replace(/^0+(?=\d)/, "") || "0";

  const normalizedRightWhole =
    rightWhole.replace(/^0+(?=\d)/, "") || "0";

  if (
    normalizedLeftWhole.length !==
    normalizedRightWhole.length
  ) {
    return normalizedLeftWhole.length <
      normalizedRightWhole.length
      ? -1
      : 1;
  }

  if (
    normalizedLeftWhole !==
    normalizedRightWhole
  ) {
    return normalizedLeftWhole <
      normalizedRightWhole
      ? -1
      : 1;
  }

  const scale = Math.max(
    leftFraction.length,
    rightFraction.length,
  );

  const normalizedLeftFraction =
    leftFraction.padEnd(scale, "0");

  const normalizedRightFraction =
    rightFraction.padEnd(scale, "0");

  if (
    normalizedLeftFraction ===
    normalizedRightFraction
  ) {
    return 0;
  }

  return normalizedLeftFraction <
    normalizedRightFraction
    ? -1
    : 1;
}

function getTodayISO(): string {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(
    now.getMonth() + 1,
  ).padStart(2, "0");

  const day = String(
    now.getDate(),
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getBatchStatus(
  batch: StockBatch,
  today: string,
): BatchAvailabilityStatus {
  if (
    batch.expiry_date &&
    batch.expiry_date < today
  ) {
    return "expired";
  }

  if (
    compareDecimalStrings(
      batch.quantity_available,
      "0",
    ) !== 1
  ) {
    return "depleted";
  }

  return "available";
}

function formatBatchDate(
  value: string | null,
): string {
  if (!value) {
    return "—";
  }

  const date = new Date(
    `${value.slice(0, 10)}T00:00:00Z`,
  );

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatSnapshotTime(
  value: string | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBatchQuantity(
  value: string,
  unit: UnitOfMeasure,
): string {
  return `${formatQuantity(value)} ${unit}`;
}

function getSourceLabel(
  sourceType: string | null,
): string {
  if (!sourceType) {
    return "Not specified";
  }

  return (
    SOURCE_TYPE_LABELS[sourceType] ??
    sourceType
      .replace(/_/g, " ")
      .replace(/\b\w/g, (letter) =>
        letter.toUpperCase(),
      )
  );
}

async function fetchStockBatches(
  filters: StockBatchFilters,
  signal?: AbortSignal,
): Promise<StockBatchesResponse> {
  return apiClient.get<StockBatchesResponse>(
    "/inventory/batches",
    {
      query: {
        page: filters.page,
        page_size: PAGE_SIZE,
        search: filters.search || undefined,
        item_type:
          filters.itemType === "all"
            ? undefined
            : filters.itemType,
        status:
          filters.status === "all"
            ? undefined
            : filters.status,
      },
      signal,
    },
  );
}

function StockBatchDetails({
  batch,
  onClose,
}: StockBatchDetailsProps) {
  const status = getBatchStatus(
    batch,
    getTodayISO(),
  );

  const details: Array<{
    label: string;
    value: string;
  }> = [
    {
      label: "Item code",
      value: batch.item_code,
    },
    {
      label: "Item name",
      value: batch.item_name,
    },
    {
      label: "Item category",
      value:
        ITEM_TYPE_LABELS[batch.item_type] ??
        batch.item_type,
    },
    {
      label: "Batch number",
      value: batch.batch_number,
    },
    {
      label: "Manufacturing date",
      value: formatBatchDate(
        batch.manufacturing_date,
      ),
    },
    {
      label: "Received date",
      value: formatBatchDate(
        batch.received_date,
      ),
    },
    {
      label: "Expiry date",
      value: formatBatchDate(
        batch.expiry_date,
      ),
    },
    {
      label: "Received quantity",
      value: formatBatchQuantity(
        batch.quantity_received,
        batch.base_unit,
      ),
    },
    {
      label: "On-hand quantity",
      value: formatBatchQuantity(
        batch.quantity_on_hand,
        batch.base_unit,
      ),
    },
    {
      label: "Reserved quantity",
      value: formatBatchQuantity(
        batch.quantity_reserved,
        batch.base_unit,
      ),
    },
    {
      label: "Available quantity",
      value: formatBatchQuantity(
        batch.quantity_available,
        batch.base_unit,
      ),
    },
    {
      label: "Unit cost",
      value: `${formatCurrency(
        batch.unit_cost,
      )} / ${batch.base_unit}`,
    },
    {
      label: "Stock value",
      value: formatCurrency(
        batch.stock_value,
      ),
    },
    {
      label: "Source transaction",
      value: getSourceLabel(
        batch.source_type,
      ),
    },
    {
      label: "Source reference",
      value: batch.source_id ?? "—",
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge
          status={status}
          label={
            status === "available"
              ? "Available"
              : status === "expired"
                ? "Expired"
                : "No available stock"
          }
          variant={
            status === "available"
              ? "success"
              : status === "expired"
                ? "error"
                : "warning"
          }
          showDot
        />

        <span className="text-xs text-text-muted">
          Batch reference: {batch.id}
        </span>
      </div>

      <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
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

      <div className="rounded-control border border-border bg-background p-4">
        <p className="text-xs leading-5 text-text-muted">
          Batch balances, reservations, costs, and
          stock values are supplied by the backend.
          FEFO allocation, expiry eligibility,
          and stock movements are enforced by
          backend inventory workflows.
        </p>
      </div>

      <div className="flex justify-end border-t border-border pt-4">
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

export function StockBatchesPage() {
  const { user } = useAuth();

  const canViewInventory =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role ===
      USER_ROLES.PRODUCTION_SUPERVISOR ||
    user?.role ===
      USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const [batches, setBatches] =
    useState<StockBatch[]>([]);

  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] =
    useState("");

  const [search, setSearch] = useState("");

  const [itemType, setItemType] =
    useState<BatchItemFilter>("all");

  const [statusFilter, setStatusFilter] =
    useState<BatchStatusFilter>("all");

  const [loading, setLoading] = useState(true);

  const [error, setError] =
    useState<string | null>(null);

  const [snapshotTime, setSnapshotTime] =
    useState<string | null>(null);

  const [selectedBatch, setSelectedBatch] =
    useState<StockBatch | null>(null);

  const today = getTodayISO();

  const filters = useMemo<StockBatchFilters>(
    () => ({
      page,
      search,
      itemType,
      status: statusFilter,
    }),
    [page, search, itemType, statusFilter],
  );

  const loadBatches = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<void> => {
      if (!canViewInventory) {
        setBatches([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchStockBatches(
          filters,
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setBatches(response.items);
        setTotal(response.total);
        setSnapshotTime(
          formatSnapshotTime(
            response.as_of,
          ),
        );
      } catch (failure) {
        if (signal?.aborted) {
          return;
        }

        setError(
          getApiErrorMessage(failure),
        );
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [canViewInventory, filters],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadBatches(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadBatches]);

  useEffect(() => {
    if (!selectedBatch) {
      return;
    }

    const handleKeyDown = (
      event: KeyboardEvent,
    ): void => {
      if (event.key === "Escape") {
        setSelectedBatch(null);
      }
    };

    window.addEventListener(
      "keydown",
      handleKeyDown,
    );

    return () => {
      window.removeEventListener(
        "keydown",
        handleKeyDown,
      );
    };
  }, [selectedBatch]);

  const handleSearch = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();

    setPage(1);
    setSearch(searchInput.trim());
  };

  const handleItemTypeChange = (
    value: BatchItemFilter,
  ): void => {
    setPage(1);
    setItemType(value);
  };

  const handleStatusChange = (
    value: BatchStatusFilter,
  ): void => {
    setPage(1);
    setStatusFilter(value);
  };

  const clearFilters = (): void => {
    setSearchInput("");
    setSearch("");
    setItemType("all");
    setStatusFilter("all");
    setPage(1);
  };

  const columns = useMemo<
    DataTableColumn<StockBatch>[]
  >(
    () => [
      {
        key: "batch_number",
        header: "Batch number",
        accessor: "batch_number",
        render: (batch) => (
          <button
            type="button"
            onClick={() =>
              setSelectedBatch(batch)
            }
            className="text-left font-semibold text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-accent"
            aria-label={`View batch ${batch.batch_number}`}
          >
            {batch.batch_number}
          </button>
        ),
      },
      {
        key: "item",
        header: "Inventory item",
        render: (batch) => (
          <div className="min-w-0">
            <p className="font-medium text-text-primary">
              {batch.item_name}
            </p>

            <p className="mt-1 text-xs text-text-muted">
              {batch.item_code}
            </p>
          </div>
        ),
      },
      {
        key: "item_type",
        header: "Category",
        render: (batch) =>
          ITEM_TYPE_LABELS[
            batch.item_type
          ] ?? batch.item_type,
        hideOnMobile: true,
      },
      {
        key: "quantity_on_hand",
        header: "On hand",
        numeric: true,
        render: (batch) => (
          <span className="app-numeric whitespace-nowrap">
            {formatBatchQuantity(
              batch.quantity_on_hand,
              batch.base_unit,
            )}
          </span>
        ),
      },
      {
        key: "quantity_reserved",
        header: "Reserved",
        numeric: true,
        render: (batch) => (
          <span className="app-numeric whitespace-nowrap">
            {formatBatchQuantity(
              batch.quantity_reserved,
              batch.base_unit,
            )}
          </span>
        ),
        hideOnMobile: true,
      },
      {
        key: "quantity_available",
        header: "Available",
        numeric: true,
        render: (batch) => (
          <span className="app-numeric whitespace-nowrap font-semibold text-text-primary">
            {formatBatchQuantity(
              batch.quantity_available,
              batch.base_unit,
            )}
          </span>
        ),
      },
      {
        key: "expiry_date",
        header: "Expiry date",
        render: (batch) =>
          formatBatchDate(
            batch.expiry_date,
          ),
      },
      {
        key: "unit_cost",
        header: "Unit cost",
        numeric: true,
        render: (batch) => (
          <span className="app-numeric whitespace-nowrap">
            {formatCurrency(
              batch.unit_cost,
            )}
          </span>
        ),
        hideOnMobile: true,
      },
      {
        key: "stock_value",
        header: "Stock value",
        numeric: true,
        render: (batch) => (
          <span className="app-numeric whitespace-nowrap">
            {formatCurrency(
              batch.stock_value,
            )}
          </span>
        ),
        hideOnMobile: true,
      },
      {
        key: "status",
        header: "Status",
        render: (batch) => {
          const status = getBatchStatus(
            batch,
            today,
          );

          return (
            <StatusBadge
              status={status}
              label={
                status === "available"
                  ? "Available"
                  : status === "expired"
                    ? "Expired"
                    : "No available stock"
              }
              variant={
                status === "available"
                  ? "success"
                  : status === "expired"
                    ? "error"
                    : "warning"
              }
              showDot
            />
          );
        },
      },
    ],
    [today],
  );

  if (!canViewInventory) {
    return (
      <div className="app-page space-y-5">
        <div>
          <h2 className="app-page-title">
            Stock Batches
          </h2>

          <p className="app-page-description">
            Batch-level inventory balances and
            expiry tracking.
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
              Stock batch information is not
              available for this role.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-page space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="app-page-title">
            Stock Batches
          </h2>

          <p className="app-page-description">
            Inspect batch-level stock, reservations,
            available quantities, expiry dates,
            source references, and inventory values.
          </p>

          {snapshotTime && (
            <p className="mt-2 flex items-center gap-2 text-xs text-text-muted">
              <CalendarClock
                size={15}
                aria-hidden="true"
              />

              <span>
                Batch data as of {snapshotTime}
              </span>
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            void loadBatches();
          }}
          disabled={loading}
          className="app-button app-button-secondary inline-flex items-center justify-center gap-2"
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

          Refresh batches
        </button>
      </div>

      <section
        aria-label="Batch inventory guidance"
        className="grid gap-4 md:grid-cols-2"
      >
        <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
          <Boxes
            size={20}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Batch traceability
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Each batch maintains its own stock
              balance, identifying number,
              expiry information, and source
              transaction reference.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
          <CalendarClock
            size={20}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              FEFO dispatch
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              First-expiry-first-out selection,
              expiry restrictions, and quantity
              checks are enforced by the backend
              during stock allocation and dispatch.
            </p>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="stock-batches-heading"
        className="app-card space-y-5"
      >
        <div>
          <h3
            id="stock-batches-heading"
            className="text-base font-semibold text-text-primary"
          >
            Batch inventory records
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            Search and filter inventory batches.
            Quantities are displayed in the
            item's base unit.
          </p>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_190px] lg:items-end">
          <form
            onSubmit={handleSearch}
            role="search"
            className="flex min-w-0 gap-2"
          >
            <label
              htmlFor="stock-batches-search"
              className="app-sr-only"
            >
              Search stock batches
            </label>

            <div className="relative min-w-0 flex-1">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />

              <input
                id="stock-batches-search"
                type="search"
                value={searchInput}
                onChange={(event) =>
                  setSearchInput(
                    event.target.value,
                  )
                }
                placeholder="Search batch or item..."
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

          <div>
            <label
              htmlFor="stock-batches-item-type"
              className="app-field-label mb-2 block"
            >
              Item category
            </label>

            <select
              id="stock-batches-item-type"
              value={itemType}
              onChange={(event) =>
                handleItemTypeChange(
                  event.target
                    .value as BatchItemFilter,
                )
              }
              className="app-select w-full"
            >
              <option value="all">
                All categories
              </option>

              <option value="raw_material">
                Raw materials
              </option>

              <option value="packaging_material">
                Packaging materials
              </option>

              <option value="finished_product">
                Finished products
              </option>
            </select>
          </div>

          <div>
            <label
              htmlFor="stock-batches-status"
              className="app-field-label mb-2 block"
            >
              Batch availability
            </label>

            <select
              id="stock-batches-status"
              value={statusFilter}
              onChange={(event) =>
                handleStatusChange(
                  event.target
                    .value as BatchStatusFilter,
                )
              }
              className="app-select w-full"
            >
              <option value="all">
                All statuses
              </option>

              <option value="available">
                Available
              </option>

              <option value="depleted">
                No available stock
              </option>

              <option value="expired">
                Expired
              </option>
            </select>
          </div>
        </div>

        {(search ||
          itemType !== "all" ||
          statusFilter !== "all") && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-text-muted">
              Filters are applied to backend
              inventory batch records.
            </p>

            <button
              type="button"
              onClick={clearFilters}
              className="text-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Clear filters
            </button>
          </div>
        )}

        {loading && batches.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading stock batches..."
          />
        ) : (
          <DataTable<StockBatch>
            columns={columns}
            data={batches}
            getRowId={(batch) => batch.id}
            loading={loading}
            error={error}
            onRetry={() => loadBatches()}
            emptyMessage="No stock batches found"
            emptyDescription={
              search ||
              itemType !== "all" ||
              statusFilter !== "all"
                ? "Try changing or clearing the selected filters."
                : "No inventory batch records are available."
            }
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="stock-batches-table"
          />
        )}

        <p className="text-xs leading-5 text-text-muted">
          Batch availability labels are
          informational. The backend determines
          actual stock eligibility, expiry handling,
          reservations, and dispatch allocation.
          Expired batches may retain physical
          on-hand quantities but must not be
          dispatched unless explicitly permitted
          by authoritative business rules.
        </p>
      </section>

      <section
        aria-label="Related inventory screens"
        className="grid gap-4 md:grid-cols-2"
      >
        <Link
          to="/inventory"
          className="group flex items-start gap-3 rounded-card border border-border bg-surface p-5 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Package
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary group-hover:text-accent">
              Stock summary
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Review aggregated inventory
              quantities, reservations, and
              weighted-average stock valuation.
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
              Trace stock-in and stock-out
              movements associated with
              inventory transactions and batches.
            </p>
          </div>
        </Link>
      </section>

      {selectedBatch && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (
              event.target ===
              event.currentTarget
            ) {
              setSelectedBatch(null);
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="stock-batch-details-title"
            className="flex max-h-[95vh] w-full max-w-3xl flex-col overflow-hidden rounded-card bg-surface shadow-xl"
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="stock-batch-details-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  Batch details
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  {selectedBatch.batch_number}
                  {" — "}
                  {selectedBatch.item_name}
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  setSelectedBatch(null)
                }
                aria-label="Close batch details"
                className="rounded-control px-3 py-2 text-sm font-medium text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                Close
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
              <StockBatchDetails
                batch={selectedBatch}
                onClose={() =>
                  setSelectedBatch(null)
                }
              />
            </div>
          </section>
        </div>
      )}

      <div className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <Boxes
            size={20}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Inventory auditability
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Batch records are maintained by
              backend inventory transactions.
              Goods receipts, production outputs,
              material consumption, dispatches,
              and authorized adjustments must
              preserve their corresponding stock
              movement history. This screen is
              read-only and does not directly
              modify stock batches.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default StockBatchesPage;