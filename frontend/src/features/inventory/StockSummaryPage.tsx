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
  Wallet,
} from "lucide-react";

import { Link } from "react-router-dom";

import type {
  InventoryItemType,
  PaginatedResponse,
  UnitOfMeasure,
  UUID,
} from "../../types/business";

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

import { useAuth } from "../../hooks/useAuth";
import { USER_ROLES } from "../../types/auth";

const PAGE_SIZE = 20;

type StockFilter =
  | "all"
  | "raw_material"
  | "packaging_material"
  | "finished_product";

type StockAvailability =
  | "in_stock"
  | "out_of_stock";

interface StockSummaryItem {
  item_id: UUID;
  item_code: string;
  item_name: string;
  item_type: InventoryItemType;
  base_unit: UnitOfMeasure;
  quantity_on_hand: string;
  quantity_reserved: string;
  quantity_available: string;
  weighted_average_cost: string;
  stock_value: string;
  active_batch_count: number;
  earliest_expiry_date: string | null;
  is_active: boolean;
}

interface StockSummaryResponse
  extends PaginatedResponse<StockSummaryItem> {
  as_of?: string;
}

interface StockSummaryMetrics {
  total_items: number;
  items_in_stock: number;
  items_out_of_stock: number;
  total_stock_value: string;
  expiring_batch_count?: number;
}

interface StockSummaryMetricsResponse {
  metrics: StockSummaryMetrics;
  as_of?: string;
}

interface StockSummaryFilters {
  page: number;
  search: string;
  itemType: StockFilter;
}

const ITEM_TYPE_LABELS: Record<
  InventoryItemType,
  string
> = {
  raw_material: "Raw material",
  packaging_material: "Packaging material",
  finished_product: "Finished product",
};

function isNonnegativeDecimal(value: string): boolean {
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

function getStockAvailability(
  item: StockSummaryItem,
): StockAvailability {
  return compareDecimalStrings(
    item.quantity_available,
    "0",
  ) === 1
    ? "in_stock"
    : "out_of_stock";
}

function formatStockQuantity(
  quantity: string,
  unit: UnitOfMeasure,
): string {
  return `${formatQuantity(quantity)} ${unit}`;
}

function formatExpiryDate(
  date: string | null,
): string {
  if (!date) {
    return "—";
  }

  const parsed = new Date(`${date}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return date;
  }

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function formatSnapshotTime(
  value: string | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

async function fetchStockSummary(
  filters: StockSummaryFilters,
  signal?: AbortSignal,
): Promise<StockSummaryResponse> {
  return apiClient.get<StockSummaryResponse>(
    "/inventory/stock-summary",
    {
      query: {
        page: filters.page,
        page_size: PAGE_SIZE,
        search: filters.search || undefined,
        item_type:
          filters.itemType === "all"
            ? undefined
            : filters.itemType,
      },
      signal,
    },
  );
}

async function fetchStockSummaryMetrics(
  signal?: AbortSignal,
): Promise<StockSummaryMetricsResponse> {
  return apiClient.get<StockSummaryMetricsResponse>(
    "/inventory/stock-summary/metrics",
    { signal },
  );
}

interface MetricCardProps {
  label: string;
  value: string;
  description: string;
  icon: typeof Package;
}

function MetricCard({
  label,
  value,
  description,
  icon: Icon,
}: MetricCardProps) {
  return (
    <article className="app-card flex items-start gap-4">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-primary/10 text-primary">
        <Icon size={21} aria-hidden="true" />
      </div>

      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium text-text-muted">
          {label}
        </h3>

        <p className="mt-1 break-words text-2xl font-semibold tracking-tight text-text-primary">
          {value}
        </p>

        <p className="mt-1 text-xs leading-5 text-text-muted">
          {description}
        </p>
      </div>
    </article>
  );
}

export function StockSummaryPage() {
  const { user } = useAuth();

  const canViewInventory =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.PRODUCTION_SUPERVISOR ||
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const [items, setItems] =
    useState<StockSummaryItem[]>([]);

  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] =
    useState("");

  const [search, setSearch] =
    useState("");

  const [itemType, setItemType] =
    useState<StockFilter>("all");

  const [metrics, setMetrics] =
    useState<StockSummaryMetrics | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [metricsLoading, setMetricsLoading] =
    useState(true);

  const [error, setError] =
    useState<string | null>(null);

  const [metricsError, setMetricsError] =
    useState<string | null>(null);

  const [snapshotTime, setSnapshotTime] =
    useState<string | null>(null);

  const [metricsSnapshotTime, setMetricsSnapshotTime] =
    useState<string | null>(null);

  const filters = useMemo<StockSummaryFilters>(
    () => ({
      page,
      search,
      itemType,
    }),
    [page, search, itemType],
  );

  const loadStockSummary = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<void> => {
      if (!canViewInventory) {
        setItems([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchStockSummary(
          filters,
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setItems(response.items);
        setTotal(response.total);
        setSnapshotTime(
          formatSnapshotTime(response.as_of),
        );
      } catch (failure) {
        if (signal?.aborted) {
          return;
        }

        setError(getApiErrorMessage(failure));
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [canViewInventory, filters],
  );

  const loadMetrics = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<void> => {
      if (!canViewInventory) {
        setMetrics(null);
        setMetricsLoading(false);
        return;
      }

      setMetricsLoading(true);
      setMetricsError(null);

      try {
        const response =
          await fetchStockSummaryMetrics(signal);

        if (signal?.aborted) {
          return;
        }

        setMetrics(response.metrics);
        setMetricsSnapshotTime(
          formatSnapshotTime(response.as_of),
        );
      } catch (failure) {
        if (signal?.aborted) {
          return;
        }

        setMetricsError(
          getApiErrorMessage(failure),
        );
      } finally {
        if (!signal?.aborted) {
          setMetricsLoading(false);
        }
      }
    },
    [canViewInventory],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadStockSummary(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadStockSummary]);

  useEffect(() => {
    const controller = new AbortController();

    void loadMetrics(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadMetrics]);

  const refreshAll = (): void => {
    void loadStockSummary();
    void loadMetrics();
  };

  const handleSearch = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();

    setPage(1);
    setSearch(searchInput.trim());
  };

  const handleItemTypeChange = (
    value: StockFilter,
  ): void => {
    setPage(1);
    setItemType(value);
  };

  const columns = useMemo<
    DataTableColumn<StockSummaryItem>[]
  >(
    () => [
      {
        key: "item_code",
        header: "Item code",
        accessor: "item_code",
        render: (item) => (
          <span className="font-medium text-text-primary">
            {item.item_code}
          </span>
        ),
      },
      {
        key: "item_name",
        header: "Item",
        accessor: "item_name",
        render: (item) => (
          <div className="min-w-0">
            <p className="font-medium text-text-primary">
              {item.item_name}
            </p>

            {!item.is_active && (
              <p className="mt-1 text-xs text-text-muted">
                Inactive item
              </p>
            )}
          </div>
        ),
      },
      {
        key: "item_type",
        header: "Category",
        render: (item) =>
          ITEM_TYPE_LABELS[item.item_type] ??
          item.item_type,
        hideOnMobile: true,
      },
      {
        key: "quantity_on_hand",
        header: "On hand",
        numeric: true,
        render: (item) => (
          <span className="app-numeric whitespace-nowrap">
            {formatStockQuantity(
              item.quantity_on_hand,
              item.base_unit,
            )}
          </span>
        ),
      },
      {
        key: "quantity_reserved",
        header: "Reserved",
        numeric: true,
        render: (item) => (
          <span className="app-numeric whitespace-nowrap">
            {formatStockQuantity(
              item.quantity_reserved,
              item.base_unit,
            )}
          </span>
        ),
        hideOnMobile: true,
      },
      {
        key: "quantity_available",
        header: "Available",
        numeric: true,
        render: (item) => (
          <span className="app-numeric whitespace-nowrap font-semibold text-text-primary">
            {formatStockQuantity(
              item.quantity_available,
              item.base_unit,
            )}
          </span>
        ),
      },
      {
        key: "weighted_average_cost",
        header: "Average cost",
        numeric: true,
        render: (item) => (
          <span className="app-numeric whitespace-nowrap">
            {formatCurrency(
              item.weighted_average_cost,
            )}
            <span className="ml-1 text-xs text-text-muted">
              / {item.base_unit}
            </span>
          </span>
        ),
        hideOnMobile: true,
      },
      {
        key: "stock_value",
        header: "Stock value",
        numeric: true,
        render: (item) => (
          <span className="app-numeric whitespace-nowrap">
            {formatCurrency(item.stock_value)}
          </span>
        ),
      },
      {
        key: "active_batch_count",
        header: "Batches",
        numeric: true,
        render: (item) => (
          <span className="app-numeric">
            {item.active_batch_count}
          </span>
        ),
        hideOnMobile: true,
      },
      {
        key: "earliest_expiry_date",
        header: "Earliest expiry",
        render: (item) =>
          formatExpiryDate(
            item.earliest_expiry_date,
          ),
        hideOnMobile: true,
      },
      {
        key: "availability",
        header: "Availability",
        render: (item) => {
          const availability =
            getStockAvailability(item);

          return (
            <StatusBadge
              status={
                availability === "in_stock"
                  ? "available"
                  : "out_of_stock"
              }
              label={
                availability === "in_stock"
                  ? "In stock"
                  : "Out of stock"
              }
              variant={
                availability === "in_stock"
                  ? "success"
                  : "warning"
              }
              showDot
            />
          );
        },
      },
    ],
    [],
  );

  if (!canViewInventory) {
    return (
      <div className="app-page space-y-5">
        <div>
          <h2 className="app-page-title">
            Stock Summary
          </h2>

          <p className="app-page-description">
            Current inventory balances and valuation.
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
              Inventory summary access is not
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
            Stock Summary
          </h2>

          <p className="app-page-description">
            Review current stock quantities,
            reservations, available balances,
            batch counts, and backend-calculated
            inventory valuation.
          </p>

          {(snapshotTime ||
            metricsSnapshotTime) && (
            <p className="mt-2 flex items-center gap-2 text-xs text-text-muted">
              <CalendarClock
                size={15}
                aria-hidden="true"
              />

              <span>
                {snapshotTime
                  ? `Stock data as of ${snapshotTime}`
                  : `Summary metrics as of ${metricsSnapshotTime}`}
              </span>
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={refreshAll}
          disabled={loading || metricsLoading}
          className="app-button app-button-secondary inline-flex items-center justify-center gap-2"
        >
          <RefreshCw
            size={17}
            className={
              loading || metricsLoading
                ? "motion-safe:animate-spin"
                : ""
            }
            aria-hidden="true"
          />

          Refresh stock
        </button>
      </div>

      <section
        aria-label="Inventory overview"
        className="space-y-4"
      >
        {metricsError && (
          <div
            role="alert"
            className="app-alert app-alert-error flex flex-wrap items-center justify-between gap-3"
          >
            <span className="flex items-start gap-2">
              <AlertCircle
                size={18}
                className="shrink-0"
                aria-hidden="true"
              />

              {metricsError}
            </span>

            <button
              type="button"
              onClick={() => {
                void loadMetrics();
              }}
              className="app-button app-button-secondary"
            >
              Retry metrics
            </button>
          </div>
        )}

        {metricsLoading && !metrics ? (
          <LoadingState
            variant="section"
            message="Loading inventory overview..."
          />
        ) : metrics ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Inventory items"
              value={metrics.total_items.toLocaleString(
                "en-IN",
              )}
              description="Total inventory items across all categories."
              icon={Package}
            />

            <MetricCard
              label="Items in stock"
              value={metrics.items_in_stock.toLocaleString(
                "en-IN",
              )}
              description="Items with a positive available balance."
              icon={Boxes}
            />

            <MetricCard
              label="Items out of stock"
              value={metrics.items_out_of_stock.toLocaleString(
                "en-IN",
              )}
              description="Items with no available quantity."
              icon={ClipboardList}
            />

            <MetricCard
              label="Inventory value"
              value={formatCurrency(
                metrics.total_stock_value,
              )}
              description="Backend-calculated stock valuation."
              icon={Wallet}
            />
          </div>
        ) : null}

        {metrics?.expiring_batch_count !== undefined && (
          <div className="flex items-center gap-2 rounded-control border border-border bg-surface px-4 py-3 text-sm text-text-muted">
            <CalendarClock
              size={17}
              className="shrink-0 text-primary"
              aria-hidden="true"
            />

            <span>
              Batches flagged as approaching expiry:{" "}
              <strong className="font-semibold text-text-primary">
                {metrics.expiring_batch_count.toLocaleString(
                  "en-IN",
                )}
              </strong>
            </span>
          </div>
        )}
      </section>

      <section
        aria-labelledby="stock-balances-heading"
        className="app-card space-y-5"
      >
        <div>
          <h3
            id="stock-balances-heading"
            className="text-base font-semibold text-text-primary"
          >
            Inventory balances
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            Quantities are shown in each item's
            base unit. All values are returned by
            the backend.
          </p>
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <form
            onSubmit={handleSearch}
            role="search"
            className="flex w-full max-w-md gap-2"
          >
            <label
              htmlFor="stock-summary-search"
              className="app-sr-only"
            >
              Search inventory items
            </label>

            <div className="relative min-w-0 flex-1">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />

              <input
                id="stock-summary-search"
                type="search"
                value={searchInput}
                onChange={(event) =>
                  setSearchInput(
                    event.target.value,
                  )
                }
                placeholder="Search code or item name..."
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

          <div className="w-full lg:w-64">
            <label
              htmlFor="stock-item-type"
              className="app-field-label mb-2 block"
            >
              Item category
            </label>

            <select
              id="stock-item-type"
              value={itemType}
              onChange={(event) =>
                handleItemTypeChange(
                  event.target.value as StockFilter,
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
        </div>

        {loading && items.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading stock balances..."
          />
        ) : (
          <DataTable<StockSummaryItem>
            columns={columns}
            data={items}
            getRowId={(item) => item.item_id}
            loading={loading}
            error={error}
            onRetry={() =>
              loadStockSummary()
            }
            emptyMessage="No inventory items found"
            emptyDescription={
              search || itemType !== "all"
                ? "Try changing the search or category filter."
                : "No inventory stock records are available."
            }
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="stock-summary-table"
          />
        )}

        <p className="text-xs leading-5 text-text-muted">
          Available quantity is the backend-reported
          quantity available after reservations.
          Stock valuation and weighted-average
          costs are authoritative backend results,
          not browser calculations.
        </p>
      </section>

      <section
        aria-label="Related inventory records"
        className="grid gap-4 md:grid-cols-2"
      >
        <Link
          to="/inventory/batches"
          className="group flex items-start gap-3 rounded-card border border-border bg-surface p-5 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Boxes
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary group-hover:text-accent">
              Stock batches
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Inspect batch-level balances,
              received quantities, and expiry
              information used for FEFO allocation.
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
              Review auditable stock-in,
              stock-out, production, dispatch,
              and adjustment movements.
            </p>
          </div>
        </Link>
      </section>

      <div className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <Package
            size={20}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-primary">
              Inventory integrity
            </h3>

            <p className="text-xs leading-5 text-text-muted">
              Stock quantities are derived from
              authorized backend inventory
              transactions. Purchase orders alone
              do not increase stock; accepted goods
              receipts, production movements,
              dispatches, and authorized adjustments
              affect inventory according to their
              respective posting workflows. This
              screen is read-only and does not
              modify inventory balances.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default StockSummaryPage;