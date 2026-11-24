import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  ClipboardList,
  FilterX,
  RefreshCw,
  Search,
} from "lucide-react";

import { Link } from "react-router-dom";

import type {
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
  formatDateTime,
  formatQuantity,
} from "../../utils/formatters";

const PAGE_SIZE = 20;

type MovementDirection = "in" | "out";

type MovementType =
  | "goods_receipt"
  | "production_consumption"
  | "production_return"
  | "production_output"
  | "dispatch"
  | "stock_adjustment"
  | "opening_stock";

type MovementTypeFilter = "all" | MovementType;
type DirectionFilter = "all" | MovementDirection;

interface StockLedgerEntry {
  id: UUID;
  item_id: UUID;
  item_code: string;
  item_name: string;
  batch_id: UUID | null;
  batch_number: string | null;
  movement_type: MovementType;
  direction: MovementDirection;
  quantity: string;
  unit: UnitOfMeasure;
  unit_cost: string | null;
  total_value: string | null;
  reference_type: string | null;
  reference_id: UUID | null;
  reference_number: string | null;
  remarks: string | null;
  movement_date: string;
  created_at: string;
  created_by: UUID | null;
}

interface StockLedgerResponse
  extends PaginatedResponse<StockLedgerEntry> {
  as_of?: string;
}

interface StockLedgerFilters {
  page: number;
  search: string;
  movementType: MovementTypeFilter;
  direction: DirectionFilter;
  dateFrom: string;
  dateTo: string;
}

interface StockLedgerDetailsProps {
  entry: StockLedgerEntry;
  onClose: () => void;
}

const MOVEMENT_TYPE_LABELS: Record<
  MovementType,
  string
> = {
  goods_receipt: "Goods receipt",
  production_consumption: "Production consumption",
  production_return: "Production return",
  production_output: "Production output",
  dispatch: "Dispatch",
  stock_adjustment: "Stock adjustment",
  opening_stock: "Opening stock",
};

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function formatMovementType(
  movementType: MovementType,
): string {
  return (
    MOVEMENT_TYPE_LABELS[movementType] ??
    movementType.replace(/_/g, " ")
  );
}

function formatDirection(
  direction: MovementDirection,
): string {
  return direction === "in" ? "Stock in" : "Stock out";
}

function formatSignedQuantity(
  entry: StockLedgerEntry,
): string {
  const prefix = entry.direction === "in" ? "+" : "−";

  return `${prefix}${formatQuantity(entry.quantity)} ${entry.unit}`;
}

function formatOptionalCurrency(
  value: string | null,
): string {
  return value === null ? "—" : formatCurrency(value);
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

async function fetchStockLedger(
  filters: StockLedgerFilters,
  signal?: AbortSignal,
): Promise<StockLedgerResponse> {
  return apiClient.get<StockLedgerResponse>(
    "/inventory/stock-ledger",
    {
      query: {
        page: filters.page,
        page_size: PAGE_SIZE,
        search: filters.search || undefined,
        movement_type:
          filters.movementType === "all"
            ? undefined
            : filters.movementType,
        direction:
          filters.direction === "all"
            ? undefined
            : filters.direction,
        date_from: filters.dateFrom || undefined,
        date_to: filters.dateTo || undefined,
      },
      signal,
    },
  );
}

function StockLedgerDetails({
  entry,
  onClose,
}: StockLedgerDetailsProps) {
  const details: Array<{
    label: string;
    value: string;
  }> = [
    {
      label: "Movement date",
      value: formatDateTime(entry.movement_date),
    },
    {
      label: "Movement type",
      value: formatMovementType(entry.movement_type),
    },
    {
      label: "Direction",
      value: formatDirection(entry.direction),
    },
    {
      label: "Item code",
      value: entry.item_code,
    },
    {
      label: "Item name",
      value: entry.item_name,
    },
    {
      label: "Quantity",
      value: formatSignedQuantity(entry),
    },
    {
      label: "Unit cost",
      value: formatOptionalCurrency(entry.unit_cost),
    },
    {
      label: "Movement value",
      value: formatOptionalCurrency(entry.total_value),
    },
    {
      label: "Batch number",
      value: entry.batch_number ?? "—",
    },
    {
      label: "Batch reference",
      value: entry.batch_id ?? "—",
    },
    {
      label: "Source type",
      value:
        entry.reference_type?.replace(/_/g, " ") ??
        "—",
    },
    {
      label: "Source document",
      value: entry.reference_number ?? "—",
    },
    {
      label: "Source reference",
      value: entry.reference_id ?? "—",
    },
    {
      label: "Recorded at",
      value: formatDateTime(entry.created_at),
    },
    {
      label: "Recorded by",
      value: entry.created_by ?? "—",
    },
    {
      label: "Movement ID",
      value: entry.id,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge
          status={entry.direction}
          label={formatDirection(entry.direction)}
          variant={
            entry.direction === "in"
              ? "success"
              : "info"
          }
          showDot
        />

        <span className="text-sm font-medium text-text-primary">
          {formatMovementType(entry.movement_type)}
        </span>
      </div>

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

      {entry.remarks && (
        <div>
          <h4 className="text-sm font-semibold text-text-primary">
            Remarks
          </h4>

          <p className="mt-2 whitespace-pre-wrap rounded-control bg-background p-3 text-sm leading-6 text-text-muted">
            {entry.remarks}
          </p>
        </div>
      )}

      <div className="rounded-control border border-border bg-background p-4">
        <p className="text-xs leading-5 text-text-muted">
          This is an auditable inventory movement
          recorded by the backend. Stock movements
          are not editable from the ledger.
          Corrections must use authorized business
          transactions while preserving movement
          history.
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

export function StockLedgerPage() {
  const { user } = useAuth();

  const canViewLedger =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.PRODUCTION_SUPERVISOR ||
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const [entries, setEntries] =
    useState<StockLedgerEntry[]>([]);

  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] =
    useState("");

  const [search, setSearch] = useState("");

  const [movementType, setMovementType] =
    useState<MovementTypeFilter>("all");

  const [direction, setDirection] =
    useState<DirectionFilter>("all");

  const [dateFromInput, setDateFromInput] =
    useState("");

  const [dateToInput, setDateToInput] =
    useState("");

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [filterError, setFilterError] =
    useState<string | null>(null);

  const [loading, setLoading] = useState(true);

  const [error, setError] =
    useState<string | null>(null);

  const [snapshotTime, setSnapshotTime] =
    useState<string | null>(null);

  const [selectedEntry, setSelectedEntry] =
    useState<StockLedgerEntry | null>(null);

  const filters = useMemo<StockLedgerFilters>(
    () => ({
      page,
      search,
      movementType,
      direction,
      dateFrom,
      dateTo,
    }),
    [
      page,
      search,
      movementType,
      direction,
      dateFrom,
      dateTo,
    ],
  );

  const loadLedger = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<void> => {
      if (!canViewLedger) {
        setEntries([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchStockLedger(
          filters,
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setEntries(response.items);
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
    [canViewLedger, filters],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadLedger(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadLedger]);

  useEffect(() => {
    if (!selectedEntry) {
      return;
    }

    const handleKeyDown = (
      event: KeyboardEvent,
    ): void => {
      if (event.key === "Escape") {
        setSelectedEntry(null);
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
  }, [selectedEntry]);

  const handleSearch = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();

    setPage(1);
    setSearch(searchInput.trim());
  };

  const handleApplyDateFilters = (
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
        "The start date cannot be after the end date.",
      );
      return;
    }

    setFilterError(null);
    setPage(1);
    setDateFrom(dateFromInput);
    setDateTo(dateToInput);
  };

  const clearFilters = (): void => {
    setSearchInput("");
    setSearch("");
    setMovementType("all");
    setDirection("all");
    setDateFromInput("");
    setDateToInput("");
    setDateFrom("");
    setDateTo("");
    setFilterError(null);
    setPage(1);
  };

  const columns = useMemo<
    DataTableColumn<StockLedgerEntry>[]
  >(
    () => [
      {
        key: "movement_date",
        header: "Movement date",
        render: (entry) => (
          <span className="whitespace-nowrap text-text-primary">
            {formatDateTime(
              entry.movement_date,
            )}
          </span>
        ),
      },
      {
        key: "item",
        header: "Inventory item",
        render: (entry) => (
          <div className="min-w-0">
            <p className="font-medium text-text-primary">
              {entry.item_name}
            </p>

            <p className="mt-1 text-xs text-text-muted">
              {entry.item_code}
            </p>
          </div>
        ),
      },
      {
        key: "batch_number",
        header: "Batch",
        render: (entry) =>
          entry.batch_number ?? "—",
        hideOnMobile: true,
      },
      {
        key: "movement_type",
        header: "Movement type",
        render: (entry) =>
          formatMovementType(
            entry.movement_type,
          ),
      },
      {
        key: "direction",
        header: "Direction",
        render: (entry) => (
          <span
            className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
              entry.direction === "in"
                ? "text-success"
                : "text-accent"
            }`}
          >
            {entry.direction === "in" ? (
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

            {formatDirection(
              entry.direction,
            )}
          </span>
        ),
      },
      {
        key: "quantity",
        header: "Quantity",
        numeric: true,
        render: (entry) => (
          <span
            className={`app-numeric whitespace-nowrap font-semibold ${
              entry.direction === "in"
                ? "text-success"
                : "text-text-primary"
            }`}
          >
            {formatSignedQuantity(entry)}
          </span>
        ),
      },
      {
        key: "unit_cost",
        header: "Unit cost",
        numeric: true,
        render: (entry) => (
          <span className="app-numeric whitespace-nowrap">
            {formatOptionalCurrency(
              entry.unit_cost,
            )}
          </span>
        ),
        hideOnMobile: true,
      },
      {
        key: "total_value",
        header: "Movement value",
        numeric: true,
        render: (entry) => (
          <span className="app-numeric whitespace-nowrap">
            {formatOptionalCurrency(
              entry.total_value,
            )}
          </span>
        ),
        hideOnMobile: true,
      },
      {
        key: "reference_number",
        header: "Reference",
        render: (entry) =>
          entry.reference_number ??
          entry.reference_id ??
          "—",
        hideOnMobile: true,
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (entry) => (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setSelectedEntry(entry);
            }}
            className="text-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-accent"
            aria-label={`View movement ${entry.id}`}
          >
            Details
          </button>
        ),
      },
    ],
    [],
  );

  if (!canViewLedger) {
    return (
      <div className="app-page space-y-5">
        <div>
          <h2 className="app-page-title">
            Stock Ledger
          </h2>

          <p className="app-page-description">
            Auditable inventory movement history.
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
              Stock ledger access is not
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
            Stock Ledger
          </h2>

          <p className="app-page-description">
            Trace stock-in and stock-out movements
            across purchasing, production, dispatch,
            and authorized inventory adjustments.
          </p>

          {snapshotTime && (
            <p className="mt-2 flex items-center gap-2 text-xs text-text-muted">
              <CalendarDays
                size={15}
                aria-hidden="true"
              />

              <span>
                Ledger data as of {snapshotTime}
              </span>
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            void loadLedger();
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

          Refresh ledger
        </button>
      </div>

      <section
        aria-label="Inventory movement guidance"
        className="grid gap-4 md:grid-cols-2"
      >
        <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
          <ArrowDownLeft
            size={21}
            className="mt-0.5 shrink-0 text-success"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Stock-in movements
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Accepted goods receipts, finished
              production output, material returns,
              and authorized positive adjustments
              are recorded as incoming inventory
              movements.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
          <ArrowUpRight
            size={21}
            className="mt-0.5 shrink-0 text-accent"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Stock-out movements
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Production material consumption,
              posted dispatches, and authorized
              negative adjustments are recorded
              as outgoing inventory movements.
            </p>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="stock-ledger-heading"
        className="app-card space-y-5"
      >
        <div>
          <h3
            id="stock-ledger-heading"
            className="text-base font-semibold text-text-primary"
          >
            Inventory movement records
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            Search by item, batch, or transaction
            reference and filter the backend
            ledger by movement type, direction,
            and date range.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px_180px] lg:items-end">
          <form
            onSubmit={handleSearch}
            role="search"
            className="flex min-w-0 gap-2"
          >
            <label
              htmlFor="stock-ledger-search"
              className="app-sr-only"
            >
              Search stock movements
            </label>

            <div className="relative min-w-0 flex-1">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />

              <input
                id="stock-ledger-search"
                type="search"
                value={searchInput}
                onChange={(event) =>
                  setSearchInput(
                    event.target.value,
                  )
                }
                placeholder="Search movements..."
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
              htmlFor="stock-ledger-movement-type"
              className="app-field-label mb-2 block"
            >
              Movement type
            </label>

            <select
              id="stock-ledger-movement-type"
              value={movementType}
              onChange={(event) => {
                setPage(1);
                setMovementType(
                  event.target
                    .value as MovementTypeFilter,
                );
              }}
              className="app-select w-full"
            >
              <option value="all">
                All movement types
              </option>

              {Object.entries(
                MOVEMENT_TYPE_LABELS,
              ).map(([value, label]) => (
                <option
                  key={value}
                  value={value}
                >
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="stock-ledger-direction"
              className="app-field-label mb-2 block"
            >
              Direction
            </label>

            <select
              id="stock-ledger-direction"
              value={direction}
              onChange={(event) => {
                setPage(1);
                setDirection(
                  event.target
                    .value as DirectionFilter,
                );
              }}
              className="app-select w-full"
            >
              <option value="all">
                All directions
              </option>

              <option value="in">
                Stock in
              </option>

              <option value="out">
                Stock out
              </option>
            </select>
          </div>
        </div>

        <form
          onSubmit={handleApplyDateFilters}
          className="flex flex-wrap items-end gap-3"
        >
          <div className="min-w-[160px] flex-1 sm:flex-none">
            <label
              htmlFor="stock-ledger-date-from"
              className="app-field-label mb-2 block"
            >
              From date
            </label>

            <input
              id="stock-ledger-date-from"
              type="date"
              value={dateFromInput}
              onChange={(event) => {
                setDateFromInput(
                  event.target.value,
                );
                setFilterError(null);
              }}
              className="app-input w-full"
            />
          </div>

          <div className="min-w-[160px] flex-1 sm:flex-none">
            <label
              htmlFor="stock-ledger-date-to"
              className="app-field-label mb-2 block"
            >
              To date
            </label>

            <input
              id="stock-ledger-date-to"
              type="date"
              value={dateToInput}
              onChange={(event) => {
                setDateToInput(
                  event.target.value,
                );
                setFilterError(null);
              }}
              className="app-input w-full"
            />
          </div>

          <button
            type="submit"
            className="app-button app-button-secondary"
          >
            Apply dates
          </button>

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
        </form>

        {filterError && (
          <div
            role="alert"
            className="app-alert app-alert-error flex items-start gap-2"
          >
            <AlertCircle
              size={17}
              className="shrink-0"
              aria-hidden="true"
            />

            {filterError}
          </div>
        )}

        {(search ||
          movementType !== "all" ||
          direction !== "all" ||
          dateFrom ||
          dateTo) && (
          <p className="text-xs text-text-muted">
            Active filters are applied to the
            backend stock ledger.
          </p>
        )}

        {loading && entries.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading stock movements..."
          />
        ) : (
          <DataTable<StockLedgerEntry>
            columns={columns}
            data={entries}
            getRowId={(entry) => entry.id}
            loading={loading}
            error={error}
            onRetry={() => loadLedger()}
            emptyMessage="No stock movements found"
            emptyDescription={
              search ||
              movementType !== "all" ||
              direction !== "all" ||
              dateFrom ||
              dateTo
                ? "Try changing or clearing the selected filters."
                : "No inventory movement records are available."
            }
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="stock-ledger-table"
          />
        )}

        <p className="text-xs leading-5 text-text-muted">
          Quantities are shown in the movement's
          recorded unit. Unit costs and transaction
          values are backend-calculated. The ledger
          displays posted inventory movements and
          does not permit direct editing or deletion.
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
              Review current item-level balances,
              reservations, and inventory valuation.
            </p>
          </div>
        </Link>

        <Link
          to="/inventory/batches"
          className="group flex items-start gap-3 rounded-card border border-border bg-surface p-5 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          <CalendarDays
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
              expiry dates, and stock availability.
            </p>
          </div>
        </Link>
      </section>

      <div className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <ClipboardList
            size={20}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Immutable movement history
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Stock ledger entries are generated
              by authorized backend transactions.
              Corrections must use controlled
              inventory adjustments or the
              applicable reversal workflow.
              Historical movements must remain
              available for reconciliation,
              traceability, and audit review.
            </p>
          </div>
        </div>
      </div>

      {selectedEntry && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          onMouseDown={(event) => {
            if (
              event.target ===
              event.currentTarget
            ) {
              setSelectedEntry(null);
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="stock-ledger-details-title"
            className="flex max-h-[95vh] w-full max-w-3xl flex-col overflow-hidden rounded-card bg-surface shadow-xl"
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="stock-ledger-details-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  Stock movement details
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  {selectedEntry.item_name}
                  {" — "}
                  {formatMovementType(
                    selectedEntry.movement_type,
                  )}
                </p>
              </div>

              <button
                type="button"
                onClick={() =>
                  setSelectedEntry(null)
                }
                aria-label="Close movement details"
                className="rounded-control px-3 py-2 text-sm font-medium text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                Close
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
              <StockLedgerDetails
                entry={selectedEntry}
                onClose={() =>
                  setSelectedEntry(null)
                }
              />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default StockLedgerPage;