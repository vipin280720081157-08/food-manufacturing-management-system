import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  AlertCircle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  ClipboardList,
  Factory,
  FileText,
  PackageCheck,
  RefreshCw,
  Scale,
  Settings2,
  WifiOff,
} from "lucide-react";

import { Link } from "react-router-dom";

import { USER_ROLES } from "../../types/auth";

import type {
  PaginatedResponse,
  ProductionStatus,
  UUID,
} from "../../types/business";

import { useAuth } from "../../hooks/useAuth";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";

import {
  apiClient,
  getApiErrorMessage,
} from "../../services/api/client";

import { LoadingState } from "../../components/common/LoadingState";
import { StatusBadge } from "../../components/common/StatusBadge";

import {
  formatDate,
  formatDateTime,
  formatQuantity,
} from "../../utils/formatters";

const RECENT_RUN_LIMIT = 5;

interface ProductionDashboardMetrics {
  total_production_runs: number;
  draft_production_runs: number;
  active_production_runs: number;
  completed_production_runs: number;
  pending_costing_runs: number;
  low_stock_materials: number;
}

interface RecentProductionRun {
  id: UUID;
  run_number: string;
  product_id: UUID;
  product_name: string;
  status: ProductionStatus;
  production_date: string;
  planned_quantity: string;
  actual_good_quantity: string | null;
  created_at: string;
}

interface ProductionDashboardData {
  metrics: ProductionDashboardMetrics;
  recentRuns: RecentProductionRun[];
  generatedAt: string;
}

interface MetricCardProps {
  title: string;
  value: number;
  description: string;
  icon: typeof Factory;
  href?: string;
  emphasis?: "default" | "success" | "warning";
}

interface QuickAction {
  title: string;
  description: string;
  href: string;
  icon: typeof Factory;
}

const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    title: "Production runs",
    description:
      "Create runs, record material movements, and post production output.",
    href: "/production/runs",
    icon: Factory,
  },
  {
    title: "Bill of materials",
    description:
      "Review approved recipes and material requirements.",
    href: "/production/boms",
    icon: ClipboardList,
  },
  {
    title: "Production costing",
    description:
      "Review backend-calculated costs, yield, and material variances.",
    href: "/production/costing",
    icon: Scale,
  },
  {
    title: "Stock summary",
    description:
      "Check available raw materials, packaging, and finished stock.",
    href: "/inventory/stock-summary",
    icon: Boxes,
  },
  {
    title: "Stock batches",
    description:
      "Review inventory batches and their recorded quantities.",
    href: "/inventory/batches",
    icon: PackageCheck,
  },
  {
    title: "Goods receipts",
    description:
      "Record authorized incoming material receipts.",
    href: "/purchasing/goods-receipts",
    icon: FileText,
  },
];

function isNonNegativeInteger(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isNonNegativeDecimal(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  );
}

function isProductionStatus(
  value: unknown,
): value is ProductionStatus {
  return (
    value === "draft" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "cancelled"
  );
}

function validateMetrics(
  value: unknown,
): ProductionDashboardMetrics {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned invalid production dashboard metrics.",
    );
  }

  const record = value as Record<string, unknown>;

  const fields = [
    "total_production_runs",
    "draft_production_runs",
    "active_production_runs",
    "completed_production_runs",
    "pending_costing_runs",
    "low_stock_materials",
  ] as const;

  for (const field of fields) {
    if (!isNonNegativeInteger(record[field])) {
      throw new Error(
        `The backend returned an invalid ${field} metric.`,
      );
    }
  }

  return record as unknown as ProductionDashboardMetrics;
}

function validateRecentRuns(
  value: unknown,
): RecentProductionRun[] {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned an invalid production run response.",
    );
  }

  const response = value as Record<string, unknown>;

  if (
    !Array.isArray(response.items) ||
    !isNonNegativeInteger(response.total)
  ) {
    throw new Error(
      "The backend returned an invalid production run list.",
    );
  }

  return response.items.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null
    ) {
      throw new Error(
        "The backend returned an invalid production run.",
      );
    }

    const run = item as Record<string, unknown>;

    if (
      typeof run.id !== "string" ||
      !run.id ||
      typeof run.run_number !== "string" ||
      typeof run.product_id !== "string" ||
      typeof run.product_name !== "string" ||
      !isProductionStatus(run.status) ||
      typeof run.production_date !== "string" ||
      !isNonNegativeDecimal(run.planned_quantity) ||
      (run.actual_good_quantity !== null &&
        !isNonNegativeDecimal(
          run.actual_good_quantity,
        )) ||
      typeof run.created_at !== "string"
    ) {
      throw new Error(
        "The backend returned an incomplete production run.",
      );
    }

    return run as unknown as RecentProductionRun;
  });
}

async function fetchProductionDashboard(
  signal?: AbortSignal,
): Promise<ProductionDashboardData> {
  const [dashboardResponse, runsResponse] =
    await Promise.all([
      apiClient.get<unknown>(
        "/dashboard/production",
        { signal },
      ),
      apiClient.get<
        PaginatedResponse<RecentProductionRun>
      >("/production/runs", {
        query: {
          page: 1,
          page_size: RECENT_RUN_LIMIT,
          sort_by: "created_at",
          sort_direction: "desc",
        },
        signal,
      }),
    ]);

  if (
    typeof dashboardResponse !== "object" ||
    dashboardResponse === null
  ) {
    throw new Error(
      "The backend returned an invalid production dashboard response.",
    );
  }

  const response = dashboardResponse as Record<
    string,
    unknown
  >;

  if (
    typeof response.generated_at !== "string" ||
    !response.generated_at
  ) {
    throw new Error(
      "The backend did not provide the dashboard generation time.",
    );
  }

  return {
    metrics: validateMetrics(response.metrics),
    recentRuns: validateRecentRuns(runsResponse),
    generatedAt: response.generated_at,
  };
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-IN").format(value);
}

function MetricCard({
  title,
  value,
  description,
  icon: Icon,
  href,
  emphasis = "default",
}: MetricCardProps) {
  const iconColor =
    emphasis === "warning"
      ? "text-warning"
      : emphasis === "success"
        ? "text-success"
        : "text-primary";

  const content: ReactNode = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-text-muted">
          {title}
        </p>

        <div className="rounded-control bg-background p-2.5">
          <Icon
            size={20}
            className={iconColor}
            aria-hidden="true"
          />
        </div>
      </div>

      <p className="app-numeric mt-3 text-3xl font-bold text-text-primary">
        {formatCount(value)}
      </p>

      <p className="mt-2 text-xs leading-5 text-text-muted">
        {description}
      </p>

      {href && (
        <span className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-accent">
          View details
          <ArrowRight
            size={14}
            aria-hidden="true"
          />
        </span>
      )}
    </>
  );

  const className =
    "block rounded-card border border-border bg-surface p-5 shadow-card transition-colors";

  if (href) {
    return (
      <Link
        to={href}
        className={`${className} hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
      >
        {content}
      </Link>
    );
  }

  return (
    <article className={className}>
      {content}
    </article>
  );
}

export function ProductionDashboardPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canAccess =
    user?.role === USER_ROLES.PRODUCTION_SUPERVISOR &&
    user.is_active;

  const [dashboard, setDashboard] =
    useState<ProductionDashboardData | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  const loadDashboard = useCallback(
    async (
      signal?: AbortSignal,
      isRefresh = false,
    ): Promise<void> => {
      if (!canAccess) {
        setDashboard(null);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError(null);

      try {
        const response =
          await fetchProductionDashboard(signal);

        if (!signal?.aborted) {
          setDashboard(response);
        }
      } catch (failure) {
        if (!signal?.aborted) {
          setError(
            getApiErrorMessage(failure),
          );

          if (!isRefresh) {
            setDashboard(null);
          }
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [canAccess],
  );

  useEffect(() => {
    const controller = new AbortController();

    if (canAccess && isOnline) {
      void loadDashboard(controller.signal);
    } else {
      setLoading(false);
      setRefreshing(false);
    }

    return () => controller.abort();
  }, [canAccess, isOnline, loadDashboard]);

  const metrics = dashboard?.metrics;

  const recentRuns = useMemo(
    () => dashboard?.recentRuns ?? [],
    [dashboard],
  );

  const hasActiveRuns =
    (metrics?.active_production_runs ?? 0) > 0;

  const hasPendingCosting =
    (metrics?.pending_costing_runs ?? 0) > 0;

  const hasLowStock =
    (metrics?.low_stock_materials ?? 0) > 0;

  if (!canAccess) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Production Dashboard
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          This dashboard is restricted to active
          Production Supervisor accounts.
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
            <Factory
              size={28}
              className="shrink-0 text-primary"
              aria-hidden="true"
            />

            <h2 className="app-page-title">
              Production Dashboard
            </h2>
          </div>

          <p className="app-page-description">
            Manufacturing activity, production runs,
            material availability, and production
            costing status.
          </p>

          {user?.full_name && (
            <p className="mt-2 text-sm font-medium text-text-primary">
              {user.full_name}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            void loadDashboard(undefined, true);
          }}
          disabled={
            !isOnline ||
            loading ||
            refreshing
          }
          className="app-button app-button-secondary inline-flex items-center justify-center gap-2"
        >
          <RefreshCw
            size={17}
            className={
              refreshing
                ? "motion-safe:animate-spin"
                : ""
            }
            aria-hidden="true"
          />

          {refreshing
            ? "Refreshing..."
            : "Refresh dashboard"}
        </button>
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
            The device is offline. Production records,
            material movements, output posting,
            expense recording, and dashboard refreshes
            require a backend connection. Previously
            loaded figures may be outdated.
          </p>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="app-alert app-alert-error flex items-start gap-3"
        >
          <AlertCircle
            size={20}
            className="shrink-0"
            aria-hidden="true"
          />

          <div className="flex-1">
            <p className="font-semibold">
              Unable to load production dashboard
            </p>

            <p className="mt-1 text-sm">
              {error}
            </p>

            {dashboard && (
              <p className="mt-2 text-xs">
                Previously retrieved figures remain
                visible and may be outdated.
              </p>
            )}
          </div>
        </div>
      )}

      {loading && !dashboard ? (
        <LoadingState
          variant="section"
          message="Loading production dashboard..."
        />
      ) : (
        <>
          <section
            aria-labelledby="production-overview-heading"
            className="space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3
                  id="production-overview-heading"
                  className="text-base font-semibold text-text-primary"
                >
                  Production overview
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Backend-calculated manufacturing
                  indicators.
                </p>
              </div>

              {dashboard?.generatedAt && (
                <p className="text-xs text-text-muted">
                  Generated:{" "}
                  {formatDateTime(
                    dashboard.generatedAt,
                  )}
                </p>
              )}
            </div>

            {metrics ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <MetricCard
                  title="Total production runs"
                  value={metrics.total_production_runs}
                  description="Production runs recorded in the authorized scope"
                  icon={Factory}
                  href="/production/runs"
                />

                <MetricCard
                  title="Draft runs"
                  value={metrics.draft_production_runs}
                  description="Production runs awaiting commencement"
                  icon={ClipboardList}
                  href="/production/runs"
                />

                <MetricCard
                  title="Active runs"
                  value={metrics.active_production_runs}
                  description="Production runs currently in progress"
                  icon={Settings2}
                  href="/production/runs"
                  emphasis={
                    hasActiveRuns
                      ? "warning"
                      : "default"
                  }
                />

                <MetricCard
                  title="Completed runs"
                  value={metrics.completed_production_runs}
                  description="Production runs marked completed by the backend"
                  icon={CheckCircle2}
                  href="/production/runs"
                  emphasis="success"
                />

                <MetricCard
                  title="Costing pending"
                  value={metrics.pending_costing_runs}
                  description="Runs requiring costing review or finalization"
                  icon={Scale}
                  href="/production/costing"
                  emphasis={
                    hasPendingCosting
                      ? "warning"
                      : "default"
                  }
                />

                <MetricCard
                  title="Low-stock materials"
                  value={metrics.low_stock_materials}
                  description="Raw or packaging materials below backend reorder thresholds"
                  icon={Boxes}
                  href="/inventory/stock-summary"
                  emphasis={
                    hasLowStock
                      ? "warning"
                      : "default"
                  }
                />
              </div>
            ) : (
              <div className="rounded-card border border-border bg-surface p-6 text-sm text-text-muted">
                {isOnline
                  ? "Production metrics are unavailable until the backend dashboard is loaded."
                  : "Production metrics cannot be retrieved while offline."}
              </div>
            )}
          </section>

          {metrics &&
            (hasPendingCosting || hasLowStock) && (
              <section
                aria-labelledby="production-attention-heading"
                className="space-y-3"
              >
                <h3
                  id="production-attention-heading"
                  className="text-base font-semibold text-text-primary"
                >
                  Items requiring attention
                </h3>

                <div className="grid gap-3 lg:grid-cols-2">
                  {hasPendingCosting && (
                    <Link
                      to="/production/costing"
                      className="flex items-start gap-3 rounded-card border border-warning/30 bg-warning/5 p-4 transition-colors hover:border-warning"
                    >
                      <Scale
                        size={21}
                        className="mt-0.5 shrink-0 text-warning"
                        aria-hidden="true"
                      />

                      <div className="flex-1">
                        <p className="text-sm font-semibold text-text-primary">
                          Production costing pending
                        </p>

                        <p className="mt-1 text-sm text-text-muted">
                          {formatCount(
                            metrics.pending_costing_runs,
                          )}{" "}
                          production{" "}
                          {metrics.pending_costing_runs ===
                          1
                            ? "run requires"
                            : "runs require"}{" "}
                          costing review or
                          finalization.
                        </p>
                      </div>

                      <ArrowRight
                        size={18}
                        className="shrink-0 text-warning"
                        aria-hidden="true"
                      />
                    </Link>
                  )}

                  {hasLowStock && (
                    <Link
                      to="/inventory/stock-summary"
                      className="flex items-start gap-3 rounded-card border border-warning/30 bg-warning/5 p-4 transition-colors hover:border-warning"
                    >
                      <Boxes
                        size={21}
                        className="mt-0.5 shrink-0 text-warning"
                        aria-hidden="true"
                      />

                      <div className="flex-1">
                        <p className="text-sm font-semibold text-text-primary">
                          Low-stock materials
                        </p>

                        <p className="mt-1 text-sm text-text-muted">
                          {formatCount(
                            metrics.low_stock_materials,
                          )}{" "}
                          {metrics.low_stock_materials ===
                          1
                            ? "material is"
                            : "materials are"}{" "}
                          below the configured
                          reorder threshold.
                        </p>
                      </div>

                      <ArrowRight
                        size={18}
                        className="shrink-0 text-warning"
                        aria-hidden="true"
                      />
                    </Link>
                  )}
                </div>
              </section>
            )}

          <section
            aria-labelledby="production-quick-actions"
            className="space-y-4"
          >
            <div>
              <h3
                id="production-quick-actions"
                className="text-base font-semibold text-text-primary"
              >
                Production operations
              </h3>

              <p className="mt-1 text-sm text-text-muted">
                Access authorized production,
                inventory, and material receipt
                workflows.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {QUICK_ACTIONS.map((action) => {
                const Icon = action.icon;

                return (
                  <Link
                    key={action.href}
                    to={action.href}
                    className="group rounded-card border border-border bg-surface p-5 shadow-card transition-colors hover:border-accent"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="rounded-control bg-primary/10 p-3 text-primary">
                        <Icon
                          size={21}
                          aria-hidden="true"
                        />
                      </div>

                      <ArrowRight
                        size={17}
                        className="text-text-muted group-hover:text-accent"
                        aria-hidden="true"
                      />
                    </div>

                    <h4 className="mt-4 text-sm font-semibold text-text-primary">
                      {action.title}
                    </h4>

                    <p className="mt-2 text-xs leading-5 text-text-muted">
                      {action.description}
                    </p>
                  </Link>
                );
              })}
            </div>
          </section>

          <section
            aria-labelledby="recent-production-runs"
            className="app-card space-y-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3
                  id="recent-production-runs"
                  className="text-base font-semibold text-text-primary"
                >
                  Recent production runs
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Latest manufacturing runs returned
                  by the backend.
                </p>
              </div>

              <Link
                to="/production/runs"
                className="inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
              >
                View all runs
                <ArrowRight
                  size={16}
                  aria-hidden="true"
                />
              </Link>
            </div>

            {recentRuns.length > 0 ? (
              <div className="app-table-container overflow-x-auto">
                <table className="app-table w-full">
                  <caption className="app-sr-only">
                    Recent production runs
                  </caption>

                  <thead>
                    <tr>
                      <th scope="col">
                        Run
                      </th>

                      <th scope="col">
                        Product
                      </th>

                      <th scope="col">
                        Production date
                      </th>

                      <th scope="col">
                        Status
                      </th>

                      <th
                        scope="col"
                        className="text-right"
                      >
                        Planned
                      </th>

                      <th
                        scope="col"
                        className="text-right"
                      >
                        Good output
                      </th>

                      <th scope="col">
                        Action
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {recentRuns.map((run) => (
                      <tr key={run.id}>
                        <td className="font-medium text-text-primary">
                          {run.run_number}
                        </td>

                        <td>
                          {run.product_name}
                        </td>

                        <td className="app-nowrap">
                          {formatDate(
                            run.production_date,
                          )}
                        </td>

                        <td>
                          <StatusBadge
                            status={run.status}
                            category="production"
                            showDot
                          />
                        </td>

                        <td className="app-numeric text-right">
                          {formatQuantity(
                            run.planned_quantity,
                          )}
                        </td>

                        <td className="app-numeric text-right">
                          {run.actual_good_quantity !==
                          null
                            ? formatQuantity(
                                run.actual_good_quantity,
                              )
                            : "—"}
                        </td>

                        <td>
                          <Link
                            to={`/production/runs/${encodeURIComponent(run.id)}`}
                            className="text-sm font-medium text-accent hover:underline"
                          >
                            Open
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-control border border-border bg-background px-5 py-8 text-center">
                <Factory
                  size={32}
                  className="mx-auto text-text-muted"
                  aria-hidden="true"
                />

                <p className="mt-3 text-sm font-medium text-text-primary">
                  No recent production runs available
                </p>

                <p className="mt-1 text-sm text-text-muted">
                  Production runs appear after they
                  are created and confirmed by the
                  backend.
                </p>
              </div>
            )}
          </section>
        </>
      )}

      <footer className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2
            size={20}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Production data integrity
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Production metrics are obtained from
              backend records. BOM scaling, material
              issues and consumption, unused material
              returns, wastage, finished-goods
              posting, stock valuation, production
              costing, and variance calculations
              remain backend-controlled. Authorized
              late expense entries may update costing
              without repeating inventory postings.
              Dashboard navigation does not perform
              stock or financial transactions.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default ProductionDashboardPage;
