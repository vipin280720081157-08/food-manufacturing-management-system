import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import {
  AlertCircle,
  ArrowRight,
  Calculator,
  ClipboardList,
  PackageCheck,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { Link, useSearchParams } from "react-router-dom";

import type {
  PaginatedResponse,
  ProductionStatus,
  UUID,
} from "../../types/business";

import { USER_ROLES } from "../../types/auth";
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
import { StatusBadge } from "../../components/common/StatusBadge";

import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatQuantity,
} from "../../utils/formatters";

const PAGE_SIZE = 20;

type CostingStatus = "pending" | "provisional" | "final";

type CostComponentType =
  | "raw_material"
  | "packaging"
  | "labour"
  | "gas_power"
  | "other_overhead";

interface ProductionCostComponent {
  id: UUID;
  component_type: CostComponentType;
  item_id: UUID | null;
  item_code: string | null;
  item_name: string | null;
  description: string | null;
  quantity: string | null;
  unit: string | null;
  unit_cost: string | null;
  total_cost: string;
  valuation_method: string | null;
  source_reference: string | null;
}

interface ProductionCostingSummary {
  production_run_id: UUID;
  run_number: string;
  product_id: UUID;
  product_code: string;
  product_name: string;
  production_date: string;
  production_status: ProductionStatus;
  costing_status: CostingStatus;
  planned_quantity: string;
  expected_good_quantity: string | null;
  actual_good_quantity: string | null;
  rejected_quantity: string | null;
  damaged_quantity: string | null;
  yield_variance: string | null;
  yield_variance_percentage: string | null;
  raw_material_cost: string;
  packaging_cost: string;
  labour_cost: string;
  gas_power_cost: string;
  other_overhead_cost: string;
  total_overhead_cost: string;
  total_production_cost: string;
  cost_per_good_unit: string | null;
  selling_price_per_unit: string | null;
  margin_per_unit: string | null;
  last_calculated_at: string | null;
}

interface ProductionCostingDetails
  extends ProductionCostingSummary {
  components: ProductionCostComponent[];
  calculation_notes: string | null;
  valuation_method: string;
  last_updated_at: string | null;
}

interface CostingFilters {
  page: number;
  search: string;
  status: string;
  dateFrom: string;
  dateTo: string;
}

const COSTING_STATUS_LABELS: Record<
  CostingStatus,
  string
> = {
  pending: "Pending",
  provisional: "Provisional",
  final: "Final",
};

const COMPONENT_LABELS: Record<
  CostComponentType,
  string
> = {
  raw_material: "Raw materials",
  packaging: "Packaging materials",
  labour: "Labour",
  gas_power: "Gas and power",
  other_overhead: "Other overhead",
};

function formatOptionalCurrency(
  value: string | null,
): string {
  return value === null
    ? "Not available"
    : formatCurrency(value);
}

function formatOptionalQuantity(
  value: string | null,
): string {
  return value === null
    ? "Not available"
    : formatQuantity(value);
}

function formatPercentage(
  value: string | null,
): string {
  if (value === null) {
    return "Not available";
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? `${new Intl.NumberFormat("en-IN", {
        maximumFractionDigits: 2,
      }).format(parsed)}%`
    : "Not available";
}

function getVarianceDirection(
  value: string | null,
): "positive" | "negative" | "neutral" {
  if (value === null) {
    return "neutral";
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed === 0) {
    return "neutral";
  }

  return parsed > 0 ? "positive" : "negative";
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

function getRunPath(runId: UUID): string {
  return `/production/runs/${encodeURIComponent(runId)}`;
}

async function fetchCostingSummaries(
  filters: CostingFilters,
  signal?: AbortSignal,
): Promise<PaginatedResponse<ProductionCostingSummary>> {
  return apiClient.get<
    PaginatedResponse<ProductionCostingSummary>
  >("/production/costing", {
    query: {
      page: filters.page,
      page_size: PAGE_SIZE,
      search: filters.search || undefined,
      status: filters.status || undefined,
      date_from: filters.dateFrom || undefined,
      date_to: filters.dateTo || undefined,
    },
    signal,
  });
}

async function fetchCostingDetails(
  runId: UUID,
  signal?: AbortSignal,
): Promise<ProductionCostingDetails> {
  return apiClient.get<ProductionCostingDetails>(
    `/production/runs/${encodeURIComponent(runId)}/costing`,
    { signal },
  );
}

interface MetricCardProps {
  label: string;
  value: string;
  description?: string;
  icon: typeof Calculator;
}

function MetricCard({
  label,
  value,
  description,
  icon: Icon,
}: MetricCardProps) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-text-muted">
          {label}
        </p>

        <Icon
          size={20}
          className="shrink-0 text-primary"
          aria-hidden="true"
        />
      </div>

      <p className="mt-3 break-words text-xl font-semibold text-text-primary app-numeric">
        {value}
      </p>

      {description && (
        <p className="mt-2 text-xs leading-5 text-text-muted">
          {description}
        </p>
      )}
    </div>
  );
}

interface CostLineProps {
  label: string;
  amount: string;
  emphasized?: boolean;
}

function CostLine({
  label,
  amount,
  emphasized = false,
}: CostLineProps) {
  return (
    <div
      className={`flex items-center justify-between gap-4 py-3 ${
        emphasized
          ? "border-t-2 border-primary font-semibold"
          : "border-b border-border"
      }`}
    >
      <span
        className={
          emphasized
            ? "text-sm text-text-primary"
            : "text-sm text-text-muted"
        }
      >
        {label}
      </span>

      <span className="app-numeric whitespace-nowrap text-sm text-text-primary">
        {formatCurrency(amount)}
      </span>
    </div>
  );
}

export function ProductionCostingPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();
  const [searchParams, setSearchParams] =
    useSearchParams();

  const canView =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.PRODUCTION_SUPERVISOR ||
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const [summaries, setSummaries] = useState<
    ProductionCostingSummary[]
  >([]);

  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] =
    useState("");

  const [search, setSearch] = useState("");

  const [statusFilter, setStatusFilter] =
    useState("");

  const [dateFromInput, setDateFromInput] =
    useState("");

  const [dateToInput, setDateToInput] =
    useState("");

  const [dateFrom, setDateFrom] =
    useState("");

  const [dateTo, setDateTo] =
    useState("");

  const [filterError, setFilterError] =
    useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] =
    useState<string | null>(null);

  const selectedRunId =
    searchParams.get("run_id");

  const [details, setDetails] =
    useState<ProductionCostingDetails | null>(null);

  const [detailsLoading, setDetailsLoading] =
    useState(false);

  const [detailsError, setDetailsError] =
    useState<string | null>(null);

  const filters = useMemo<CostingFilters>(
    () => ({
      page,
      search,
      status: statusFilter,
      dateFrom,
      dateTo,
    }),
    [
      page,
      search,
      statusFilter,
      dateFrom,
      dateTo,
    ],
  );

  const loadSummaries = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canView) {
        setSummaries([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchCostingSummaries(
          filters,
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setSummaries(response.items);
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
    [canView, filters],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadSummaries(controller.signal);

    return () => controller.abort();
  }, [loadSummaries]);

  useEffect(() => {
    if (!selectedRunId || !canView) {
      setDetails(null);
      setDetailsError(null);
      setDetailsLoading(false);
      return;
    }

    const controller = new AbortController();

    const loadDetails = async (): Promise<void> => {
      setDetails(null);
      setDetailsLoading(true);
      setDetailsError(null);

      try {
        const response = await fetchCostingDetails(
          selectedRunId,
          controller.signal,
        );

        if (!controller.signal.aborted) {
          setDetails(response);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setDetailsError(
            getApiErrorMessage(failure),
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setDetailsLoading(false);
        }
      }
    };

    void loadDetails();

    return () => controller.abort();
  }, [selectedRunId, canView]);

  const selectRun = useCallback(
    (runId: UUID): void => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);

        next.set("run_id", runId);

        return next;
      });
    },
    [setSearchParams],
  );

  const clearSelection = (): void => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);

      next.delete("run_id");

      return next;
    });
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
    setStatusFilter("");
    setDateFromInput("");
    setDateToInput("");
    setDateFrom("");
    setDateTo("");
    setFilterError(null);
    setPage(1);
  };

  const columns = useMemo<
    DataTableColumn<ProductionCostingSummary>[]
  >(
    () => [
      {
        key: "run_number",
        header: "Production run",
        render: (row) => (
          <button
            type="button"
            onClick={() =>
              selectRun(row.production_run_id)
            }
            className="text-left font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {row.run_number}
          </button>
        ),
      },
      {
        key: "production_date",
        header: "Production date",
        render: (row) =>
          formatDate(row.production_date),
      },
      {
        key: "product",
        header: "Product",
        render: (row) => (
          <div>
            <p className="font-medium text-text-primary">
              {row.product_name}
            </p>

            <p className="mt-1 text-xs text-text-muted">
              {row.product_code}
            </p>
          </div>
        ),
      },
      {
        key: "actual_good_quantity",
        header: "Good output",
        numeric: true,
        render: (row) => (
          <span className="app-numeric">
            {formatOptionalQuantity(
              row.actual_good_quantity,
            )}
          </span>
        ),
      },
      {
        key: "total_production_cost",
        header: "Total cost",
        numeric: true,
        render: (row) => (
          <span className="app-numeric">
            {formatCurrency(
              row.total_production_cost,
            )}
          </span>
        ),
      },
      {
        key: "cost_per_good_unit",
        header: "Cost / good unit",
        numeric: true,
        render: (row) => (
          <span className="app-numeric">
            {formatOptionalCurrency(
              row.cost_per_good_unit,
            )}
          </span>
        ),
      },
      {
        key: "costing_status",
        header: "Costing",
        render: (row) => (
          <StatusBadge
            status={row.costing_status}
            label={
              COSTING_STATUS_LABELS[
                row.costing_status
              ]
            }
            variant={
              row.costing_status === "final"
                ? "success"
                : row.costing_status === "provisional"
                  ? "warning"
                  : "neutral"
            }
            showDot
          />
        ),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (row) => (
          <div className="flex flex-wrap justify-end gap-3">
            <button
              type="button"
              onClick={() =>
                selectRun(row.production_run_id)
              }
              className="text-sm font-medium text-accent hover:underline"
            >
              Cost details
            </button>

            <Link
              to={getRunPath(
                row.production_run_id,
              )}
              className="text-sm font-medium text-primary hover:underline"
            >
              Open run
            </Link>
          </div>
        ),
      },
    ],
    [selectRun],
  );

  if (!canView) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Production Costing
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Production costing access is not
          available for this role.
        </div>
      </div>
    );
  }

  return (
    <div className="app-page space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="app-page-title">
            Production Costing
          </h2>

          <p className="app-page-description">
            Review actual material costs,
            packaging costs, labour, overheads,
            production yield, and cost per good
            finished unit.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            void loadSummaries();
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
            Production costing is retrieved from
            the backend. An active connection is
            required to load or refresh official
            costing records.
          </p>
        </div>
      )}

      <div className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <Calculator
            size={20}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Backend-authoritative costing
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Production costs are calculated from
              posted material consumption and
              applicable weighted-average inventory
              valuations, packaging usage, and
              recorded production expenses.
              Cost per good unit is based on actual
              good output, not planned output.
              Later authorized expense entries
              update costing without duplicating
              inventory movements.
            </p>
          </div>
        </div>
      </div>

      <section
        aria-labelledby="production-costing-list-title"
        className="app-card space-y-5"
      >
        <div>
          <h3
            id="production-costing-list-title"
            className="text-base font-semibold text-text-primary"
          >
            Production costing records
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            Select a production run to inspect
            its backend-calculated cost breakdown.
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
                htmlFor="costing-search"
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
                  id="costing-search"
                  type="search"
                  value={searchInput}
                  onChange={(event) =>
                    setSearchInput(
                      event.target.value,
                    )
                  }
                  placeholder="Run or product..."
                  className="app-input w-full pl-10"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="costing-status"
                className="app-field-label mb-2 block"
              >
                Costing status
              </label>

              <select
                id="costing-status"
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(
                    event.target.value,
                  );
                  setPage(1);
                }}
                className="app-select w-full"
              >
                <option value="">
                  All statuses
                </option>
                <option value="pending">
                  Pending
                </option>
                <option value="provisional">
                  Provisional
                </option>
                <option value="final">
                  Final
                </option>
              </select>
            </div>

            <div>
              <label
                htmlFor="costing-date-from"
                className="app-field-label mb-2 block"
              >
                Date from
              </label>

              <input
                id="costing-date-from"
                type="date"
                value={dateFromInput}
                onChange={(event) =>
                  setDateFromInput(
                    event.target.value,
                  )
                }
                className="app-input w-full"
              />
            </div>

            <div>
              <label
                htmlFor="costing-date-to"
                className="app-field-label mb-2 block"
              >
                Date to
              </label>

              <input
                id="costing-date-to"
                type="date"
                value={dateToInput}
                onChange={(event) =>
                  setDateToInput(
                    event.target.value,
                  )
                }
                className="app-input w-full"
              />
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={clearFilters}
              className="app-button app-button-secondary"
            >
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

        {loading && summaries.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading production costing..."
          />
        ) : (
          <DataTable<ProductionCostingSummary>
            columns={columns}
            data={summaries}
            getRowId={(row) =>
              row.production_run_id
            }
            loading={loading}
            error={error}
            onRetry={() => loadSummaries()}
            emptyMessage="No production costing records found"
            emptyDescription="No costing records match the selected filters."
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="production-costing-table"
          />
        )}
      </section>

      {selectedRunId && (
        <section
          aria-labelledby="costing-details-title"
          className="app-card space-y-6"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3
                id="costing-details-title"
                className="text-lg font-semibold text-text-primary"
              >
                Costing breakdown
              </h3>

              <p className="mt-1 text-sm text-text-muted">
                Detailed production costs,
                yield analysis, and source
                records.
              </p>
            </div>

            <button
              type="button"
              onClick={clearSelection}
              className="app-button app-button-secondary"
            >
              Close details
            </button>
          </div>

          {detailsLoading && (
            <LoadingState
              variant="section"
              message="Loading cost breakdown..."
            />
          )}

          {detailsError && (
            <div
              role="alert"
              className="app-alert app-alert-error"
            >
              {detailsError}
            </div>
          )}

          {!detailsLoading &&
            !detailsError &&
            details && (
              <div className="space-y-6">
                <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h4 className="text-base font-semibold text-text-primary">
                      {details.run_number}
                    </h4>

                    <p className="mt-1 text-sm text-text-muted">
                      {details.product_name} (
                      {details.product_code})
                    </p>

                    <p className="mt-1 text-xs text-text-muted">
                      Production date:{" "}
                      {formatDate(
                        details.production_date,
                      )}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <StatusBadge
                      status={
                        details.production_status
                      }
                      category="production"
                      showDot
                    />

                    <StatusBadge
                      status={
                        details.costing_status
                      }
                      label={
                        COSTING_STATUS_LABELS[
                          details.costing_status
                        ]
                      }
                      variant={
                        details.costing_status ===
                        "final"
                          ? "success"
                          : details.costing_status ===
                              "provisional"
                            ? "warning"
                            : "neutral"
                      }
                      showDot
                    />
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <MetricCard
                    label="Total production cost"
                    value={formatCurrency(
                      details.total_production_cost,
                    )}
                    icon={Calculator}
                  />

                  <MetricCard
                    label="Cost per good unit"
                    value={formatOptionalCurrency(
                      details.cost_per_good_unit,
                    )}
                    description={
                      details.cost_per_good_unit ===
                      null
                        ? "Unavailable until valid good output is recorded."
                        : "Backend-calculated unit cost."
                    }
                    icon={PackageCheck}
                  />

                  <MetricCard
                    label="Actual good output"
                    value={formatOptionalQuantity(
                      details.actual_good_quantity,
                    )}
                    icon={ClipboardList}
                  />

                  <MetricCard
                    label="Yield variance"
                    value={formatOptionalQuantity(
                      details.yield_variance,
                    )}
                    description={formatPercentage(
                      details.yield_variance_percentage,
                    )}
                    icon={
                      getVarianceDirection(
                        details.yield_variance,
                      ) === "negative"
                        ? TrendingDown
                        : TrendingUp
                    }
                  />
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <div className="rounded-card border border-border p-5">
                    <h4 className="text-base font-semibold text-text-primary">
                      Cost composition
                    </h4>

                    <div className="mt-4">
                      <CostLine
                        label="Raw materials"
                        amount={
                          details.raw_material_cost
                        }
                      />

                      <CostLine
                        label="Packaging materials"
                        amount={
                          details.packaging_cost
                        }
                      />

                      <CostLine
                        label="Labour"
                        amount={details.labour_cost}
                      />

                      <CostLine
                        label="Gas and power"
                        amount={
                          details.gas_power_cost
                        }
                      />

                      <CostLine
                        label="Other overheads"
                        amount={
                          details.other_overhead_cost
                        }
                      />

                      <CostLine
                        label="Total production overheads"
                        amount={
                          details.total_overhead_cost
                        }
                      />

                      <CostLine
                        label="Total production cost"
                        amount={
                          details.total_production_cost
                        }
                        emphasized
                      />
                    </div>

                    <p className="mt-4 text-xs leading-5 text-text-muted">
                      All displayed values are
                      returned by the backend.
                      Overhead totals and
                      production costs are not
                      recalculated in this screen.
                    </p>
                  </div>

                  <div className="rounded-card border border-border p-5">
                    <h4 className="text-base font-semibold text-text-primary">
                      Production yield and margin
                    </h4>

                    <dl className="mt-4 space-y-4">
                      {[
                        {
                          label: "Planned quantity",
                          value: formatQuantity(
                            details.planned_quantity,
                          ),
                        },
                        {
                          label:
                            "Expected good output",
                          value:
                            formatOptionalQuantity(
                              details.expected_good_quantity,
                            ),
                        },
                        {
                          label:
                            "Actual good output",
                          value:
                            formatOptionalQuantity(
                              details.actual_good_quantity,
                            ),
                        },
                        {
                          label:
                            "Rejected quantity",
                          value:
                            formatOptionalQuantity(
                              details.rejected_quantity,
                            ),
                        },
                        {
                          label:
                            "Damaged quantity",
                          value:
                            formatOptionalQuantity(
                              details.damaged_quantity,
                            ),
                        },
                        {
                          label: "Yield variance",
                          value:
                            formatOptionalQuantity(
                              details.yield_variance,
                            ),
                        },
                        {
                          label:
                            "Yield variance percentage",
                          value: formatPercentage(
                            details.yield_variance_percentage,
                          ),
                        },
                        {
                          label:
                            "Selling price per unit",
                          value:
                            formatOptionalCurrency(
                              details.selling_price_per_unit,
                            ),
                        },
                        {
                          label: "Margin per unit",
                          value:
                            formatOptionalCurrency(
                              details.margin_per_unit,
                            ),
                        },
                      ].map((item) => (
                        <div
                          key={item.label}
                          className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-3"
                        >
                          <dt className="text-sm text-text-muted">
                            {item.label}
                          </dt>

                          <dd className="app-numeric text-sm font-medium text-text-primary">
                            {item.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <h4 className="text-base font-semibold text-text-primary">
                      Detailed cost components
                    </h4>

                    <p className="mt-1 text-sm text-text-muted">
                      Source-linked material
                      valuations and production
                      expenses recorded against
                      this run.
                    </p>
                  </div>

                  <div className="app-table-container">
                    <table className="app-table w-full">
                      <thead>
                        <tr>
                          <th scope="col">
                            Component
                          </th>

                          <th scope="col">
                            Description
                          </th>

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
                            Unit cost
                          </th>

                          <th
                            scope="col"
                            className="text-right"
                          >
                            Total cost
                          </th>

                          <th scope="col">
                            Source
                          </th>
                        </tr>
                      </thead>

                      <tbody>
                        {details.components.map(
                          (component) => (
                            <tr key={component.id}>
                              <td className="font-medium">
                                {
                                  COMPONENT_LABELS[
                                    component.component_type
                                  ]
                                }
                              </td>

                              <td>
                                <p className="font-medium">
                                  {component.item_name ??
                                    component.description ??
                                    "—"}
                                </p>

                                {component.item_code && (
                                  <p className="mt-1 text-xs text-text-muted">
                                    {
                                      component.item_code
                                    }
                                  </p>
                                )}
                              </td>

                              <td className="app-numeric whitespace-nowrap text-right">
                                {component.quantity ===
                                null
                                  ? "—"
                                  : `${formatQuantity(component.quantity)} ${component.unit ?? ""}`.trim()}
                              </td>

                              <td className="app-numeric whitespace-nowrap text-right">
                                {formatOptionalCurrency(
                                  component.unit_cost,
                                )}
                              </td>

                              <td className="app-numeric whitespace-nowrap text-right">
                                {formatCurrency(
                                  component.total_cost,
                                )}
                              </td>

                              <td>
                                <p className="break-all text-xs text-text-muted">
                                  {component.source_reference ??
                                    "—"}
                                </p>

                                {component.valuation_method && (
                                  <p className="mt-1 text-xs text-text-muted">
                                    {
                                      component.valuation_method
                                    }
                                  </p>
                                )}
                              </td>
                            </tr>
                          ),
                        )}

                        {details.components.length ===
                          0 && (
                          <tr>
                            <td
                              colSpan={6}
                              className="py-6 text-center text-text-muted"
                            >
                              No detailed cost
                              components were
                              returned.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="rounded-control border border-border bg-background p-4">
                  <h4 className="text-sm font-semibold text-text-primary">
                    Calculation and audit
                    information
                  </h4>

                  <dl className="mt-3 grid gap-4 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-text-muted">
                        Valuation method
                      </dt>

                      <dd className="mt-1 text-sm font-medium text-text-primary">
                        {details.valuation_method}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-xs text-text-muted">
                        Last calculated
                      </dt>

                      <dd className="mt-1 text-sm font-medium text-text-primary">
                        {details.last_calculated_at
                          ? formatDateTime(
                              details.last_calculated_at,
                            )
                          : "Not calculated"}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-xs text-text-muted">
                        Last updated
                      </dt>

                      <dd className="mt-1 text-sm font-medium text-text-primary">
                        {details.last_updated_at
                          ? formatDateTime(
                              details.last_updated_at,
                            )
                          : "—"}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-xs text-text-muted">
                        Production run reference
                      </dt>

                      <dd className="mt-1 break-all text-sm font-medium text-text-primary">
                        {
                          details.production_run_id
                        }
                      </dd>
                    </div>
                  </dl>

                  {details.calculation_notes && (
                    <div className="mt-4">
                      <p className="text-xs font-medium text-text-muted">
                        Calculation notes
                      </p>

                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-primary">
                        {
                          details.calculation_notes
                        }
                      </p>
                    </div>
                  )}
                </div>

                {details.cost_per_good_unit ===
                  null && (
                  <div
                    role="status"
                    className="app-alert app-alert-warning"
                  >
                    Cost per good unit is not
                    available. A valid positive
                    actual good-output quantity
                    is required before the backend
                    can calculate unit cost.
                  </div>
                )}

                <div className="flex flex-wrap justify-end gap-3">
                  <Link
                    to={getRunPath(
                      details.production_run_id,
                    )}
                    className="app-button app-button-primary inline-flex items-center gap-2"
                  >
                    Open production run
                    <ArrowRight
                      size={16}
                      aria-hidden="true"
                    />
                  </Link>
                </div>
              </div>
            )}
        </section>
      )}

      <div className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <AlertCircle
            size={20}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Costing and inventory integrity
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              This page is read-only. It does not
              post inventory movements, alter
              production expenses, or independently
              calculate financial values. Actual
              material usage, packaging quantities,
              overhead allocation, production
              yield, and subsequent costing
              revisions remain authoritative in
              the backend and its audit history.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ProductionCostingPage;