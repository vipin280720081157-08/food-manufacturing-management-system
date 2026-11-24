import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  Boxes,
  CheckCircle2,
  ClipboardCheck,
  Factory,
  FileText,
  IndianRupee,
  PackageCheck,
  RefreshCw,
  Scale,
  ShieldCheck,
  ShoppingCart,
  TrendingUp,
  Truck,
  Users,
  Wallet,
  WifiOff,
} from "lucide-react";

import { Link } from "react-router-dom";

import { USER_ROLES } from "../../types/auth";

import type {
  OrderApprovalStatus,
  PaginatedResponse,
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
  formatCurrency,
  formatDate,
  formatDateTime,
} from "../../utils/formatters";

const RECENT_ORDER_LIMIT = 5;

interface OwnerDashboardMetrics {
  total_customers: number;
  total_suppliers: number;
  total_sales_orders: number;
  pending_order_approvals: number;
  approved_orders: number;
  active_production_runs: number;
  completed_production_runs: number;
  pending_dispatches: number;
  low_stock_items: number;
  pending_costing_runs: number;
  total_invoiced_amount: string;
  total_collected_amount: string;
  outstanding_amount: string;
  overdue_amount: string;
}

interface OwnerDashboardResponse {
  metrics: OwnerDashboardMetrics;
  generated_at: string;
}

interface RecentSalesOrder {
  id: UUID;
  order_number: string;
  customer_id: UUID;
  customer_name: string;
  order_date: string;
  approval_status: OrderApprovalStatus;
  total_amount: string;
}

interface OwnerDashboardData {
  metrics: OwnerDashboardMetrics;
  recentOrders: RecentSalesOrder[];
  generatedAt: string;
}

interface MetricCardProps {
  label: string;
  value: string;
  description: string;
  icon: typeof TrendingUp;
  href?: string;
  emphasis?: "default" | "warning" | "success";
}

interface NavigationItem {
  title: string;
  description: string;
  href: string;
  icon: typeof TrendingUp;
}

const NAVIGATION_ITEMS: readonly NavigationItem[] = [
  {
    title: "Business reports",
    description:
      "Review financial, operational, inventory, and sales reports.",
    href: "/reports",
    icon: BarChart3,
  },
  {
    title: "Sales orders",
    description:
      "Inspect customer orders and their approval statuses.",
    href: "/sales/orders",
    icon: ShoppingCart,
  },
  {
    title: "GST invoices",
    description:
      "Review invoice totals and backend-calculated GST.",
    href: "/invoices",
    icon: FileText,
  },
  {
    title: "Customer receivables",
    description:
      "Examine outstanding balances and overdue amounts.",
    href: "/payments/outstanding",
    icon: IndianRupee,
  },
  {
    title: "Payment register",
    description:
      "Review posted customer payments and allocations.",
    href: "/payments",
    icon: Wallet,
  },
  {
    title: "Production runs",
    description:
      "Monitor manufacturing progress and completed production.",
    href: "/production/runs",
    icon: Factory,
  },
  {
    title: "Production costing",
    description:
      "Inspect material costs, expenses, yield, and costing variances.",
    href: "/production/costing",
    icon: Scale,
  },
  {
    title: "Inventory summary",
    description:
      "Review available inventory and low-stock items.",
    href: "/inventory/stock-summary",
    icon: Boxes,
  },
  {
    title: "Dispatch register",
    description:
      "Inspect finished-goods dispatch records.",
    href: "/dispatch",
    icon: Truck,
  },
  {
    title: "Purchasing",
    description:
      "Review purchase orders and procurement activity.",
    href: "/purchasing/purchases",
    icon: PackageCheck,
  },
  {
    title: "Customers",
    description:
      "Review customer master records and assignments.",
    href: "/customers",
    icon: Users,
  },
  {
    title: "Suppliers",
    description:
      "Review supplier master records.",
    href: "/suppliers",
    icon: ClipboardCheck,
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

function isNonNegativeDecimalString(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  );
}

function isOrderApprovalStatus(
  value: unknown,
): value is OrderApprovalStatus {
  return (
    value === "draft" ||
    value === "submitted" ||
    value === "approved" ||
    value === "rejected" ||
    value === "cancelled"
  );
}

function validateMetrics(
  value: unknown,
): OwnerDashboardMetrics {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned invalid owner dashboard metrics.",
    );
  }

  const record = value as Record<string, unknown>;

  const countFields = [
    "total_customers",
    "total_suppliers",
    "total_sales_orders",
    "pending_order_approvals",
    "approved_orders",
    "active_production_runs",
    "completed_production_runs",
    "pending_dispatches",
    "low_stock_items",
    "pending_costing_runs",
  ] as const;

  const monetaryFields = [
    "total_invoiced_amount",
    "total_collected_amount",
    "outstanding_amount",
    "overdue_amount",
  ] as const;

  for (const field of countFields) {
    if (!isNonNegativeInteger(record[field])) {
      throw new Error(
        `The backend returned an invalid ${field} metric.`,
      );
    }
  }

  for (const field of monetaryFields) {
    if (!isNonNegativeDecimalString(record[field])) {
      throw new Error(
        `The backend returned an invalid ${field} amount.`,
      );
    }
  }

  return record as unknown as OwnerDashboardMetrics;
}

function validateRecentOrders(
  value: unknown,
): RecentSalesOrder[] {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned an invalid sales order response.",
    );
  }

  const response = value as Record<string, unknown>;

  if (
    !Array.isArray(response.items) ||
    !isNonNegativeInteger(response.total)
  ) {
    throw new Error(
      "The backend returned an invalid sales order list.",
    );
  }

  return response.items.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null
    ) {
      throw new Error(
        "The backend returned an invalid sales order.",
      );
    }

    const order = item as Record<string, unknown>;

    if (
      typeof order.id !== "string" ||
      !order.id ||
      typeof order.order_number !== "string" ||
      typeof order.customer_id !== "string" ||
      typeof order.customer_name !== "string" ||
      typeof order.order_date !== "string" ||
      !isOrderApprovalStatus(
        order.approval_status,
      ) ||
      !isNonNegativeDecimalString(
        order.total_amount,
      )
    ) {
      throw new Error(
        "The backend returned an incomplete sales order.",
      );
    }

    return order as unknown as RecentSalesOrder;
  });
}

function validateDashboardResponse(
  value: unknown,
): OwnerDashboardResponse {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned an invalid owner dashboard response.",
    );
  }

  const response = value as Record<string, unknown>;

  if (
    typeof response.generated_at !== "string" ||
    !response.generated_at ||
    Number.isNaN(
      Date.parse(response.generated_at),
    )
  ) {
    throw new Error(
      "The backend returned an invalid dashboard generation time.",
    );
  }

  return {
    metrics: validateMetrics(response.metrics),
    generated_at: response.generated_at,
  };
}

async function fetchOwnerDashboard(
  signal?: AbortSignal,
): Promise<OwnerDashboardData> {
  const [dashboardResponse, ordersResponse] =
    await Promise.all([
      apiClient.get<unknown>(
        "/dashboard/owner",
        { signal },
      ),
      apiClient.get<
        PaginatedResponse<RecentSalesOrder>
      >("/sales/orders", {
        query: {
          page: 1,
          page_size: RECENT_ORDER_LIMIT,
          sort_by: "created_at",
          sort_direction: "desc",
        },
        signal,
      }),
    ]);

  const validatedDashboard =
    validateDashboardResponse(
      dashboardResponse,
    );

  return {
    metrics: validatedDashboard.metrics,
    recentOrders: validateRecentOrders(
      ordersResponse,
    ),
    generatedAt:
      validatedDashboard.generated_at,
  };
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-IN").format(
    value,
  );
}

function hasPositiveAmount(value: string): boolean {
  return /[1-9]/.test(value);
}

function MetricCard({
  label,
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
          {label}
        </p>

        <div className="rounded-control bg-background p-2.5">
          <Icon
            size={20}
            className={iconColor}
            aria-hidden="true"
          />
        </div>
      </div>

      <p className="app-numeric mt-3 break-words text-2xl font-bold text-text-primary">
        {value}
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

export function OwnerDashboardPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canAccess =
    user?.role === USER_ROLES.OWNER &&
    user.is_active;

  const [dashboard, setDashboard] =
    useState<OwnerDashboardData | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  const requestIdRef = useRef(0);
  const activeControllerRef =
    useRef<AbortController | null>(null);

  const loadDashboard = useCallback(
    async (isRefresh = false): Promise<void> => {
      if (!canAccess || !isOnline) {
        return;
      }

      activeControllerRef.current?.abort();

      const controller = new AbortController();
      activeControllerRef.current = controller;

      const requestId = ++requestIdRef.current;

      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError(null);

      try {
        const response =
          await fetchOwnerDashboard(
            controller.signal,
          );

        if (
          controller.signal.aborted ||
          requestId !== requestIdRef.current
        ) {
          return;
        }

        setDashboard(response);
      } catch (failure) {
        if (
          controller.signal.aborted ||
          requestId !== requestIdRef.current
        ) {
          return;
        }

        setError(
          getApiErrorMessage(failure),
        );

        if (!isRefresh) {
          setDashboard(null);
        }
      } finally {
        if (
          !controller.signal.aborted &&
          requestId === requestIdRef.current
        ) {
          setLoading(false);
          setRefreshing(false);
        }

        if (
          activeControllerRef.current ===
          controller
        ) {
          activeControllerRef.current = null;
        }
      }
    },
    [canAccess, isOnline],
  );

  useEffect(() => {
    if (canAccess && isOnline) {
      void loadDashboard();
    } else {
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      requestIdRef.current += 1;

      setLoading(false);
      setRefreshing(false);

      if (!canAccess) {
        setDashboard(null);
        setError(null);
      }
    }

    return () => {
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      requestIdRef.current += 1;
    };
  }, [canAccess, isOnline, loadDashboard]);

  const metrics = dashboard?.metrics;

  const recentOrders = useMemo(
    () => dashboard?.recentOrders ?? [],
    [dashboard],
  );

  const hasPendingApprovals =
    (metrics?.pending_order_approvals ?? 0) > 0;

  const hasLowStock =
    (metrics?.low_stock_items ?? 0) > 0;

  const hasPendingCosting =
    (metrics?.pending_costing_runs ?? 0) > 0;

  const hasOverdueReceivables =
    metrics !== undefined &&
    hasPositiveAmount(
      metrics.overdue_amount,
    );

  if (!canAccess) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Owner Dashboard
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          This dashboard is restricted to active
          Owner accounts.
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
            <TrendingUp
              size={28}
              className="shrink-0 text-primary"
              aria-hidden="true"
            />

            <h2 className="app-page-title">
              Owner Dashboard
            </h2>
          </div>

          <p className="app-page-description">
            Read-only business overview of sales,
            collections, production, inventory,
            dispatch, and operational performance.
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
            void loadDashboard(true);
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

      <section
        aria-label="Owner access level"
        className="rounded-card border border-border bg-surface p-4"
      >
        <div className="flex items-start gap-3">
          <ShieldCheck
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Read-only business oversight
            </h3>

            <p className="mt-1 text-sm leading-6 text-text-muted">
              This dashboard provides visibility
              across authorized business records.
              Owner access does not permit modifying
              master data, approving orders, posting
              inventory transactions, or recording
              financial transactions.
            </p>
          </div>
        </div>
      </section>

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
            The device is offline. Business dashboard
            data cannot be refreshed without the
            backend. Previously retrieved information
            may be outdated.
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
              Unable to load owner dashboard
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
          message="Loading business overview..."
        />
      ) : (
        <>
          <section
            aria-labelledby="owner-financial-overview"
            className="space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3
                  id="owner-financial-overview"
                  className="text-base font-semibold text-text-primary"
                >
                  Financial overview
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Backend-calculated invoice,
                  collection, and receivable balances.
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
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                  label="Total invoiced"
                  value={formatCurrency(
                    metrics.total_invoiced_amount,
                  )}
                  description="Invoice value reported by the backend"
                  icon={FileText}
                  href="/invoices"
                />

                <MetricCard
                  label="Total collected"
                  value={formatCurrency(
                    metrics.total_collected_amount,
                  )}
                  description="Customer payments recognized by the backend"
                  icon={Wallet}
                  href="/payments"
                  emphasis="success"
                />

                <MetricCard
                  label="Outstanding receivables"
                  value={formatCurrency(
                    metrics.outstanding_amount,
                  )}
                  description="Uncollected customer invoice balances"
                  icon={IndianRupee}
                  href="/payments/outstanding"
                />

                <MetricCard
                  label="Overdue receivables"
                  value={formatCurrency(
                    metrics.overdue_amount,
                  )}
                  description="Overdue amounts determined by backend aging rules"
                  icon={AlertCircle}
                  href="/payments/outstanding"
                  emphasis={
                    hasOverdueReceivables
                      ? "warning"
                      : "default"
                  }
                />
              </div>
            ) : (
              <div className="rounded-card border border-border bg-surface p-6 text-sm text-text-muted">
                {isOnline
                  ? "Financial metrics are unavailable until the backend dashboard is loaded."
                  : "Financial metrics cannot be retrieved while offline."}
              </div>
            )}
          </section>

          <section
            aria-labelledby="owner-operational-overview"
            className="space-y-4"
          >
            <div>
              <h3
                id="owner-operational-overview"
                className="text-base font-semibold text-text-primary"
              >
                Operational overview
              </h3>

              <p className="mt-1 text-sm text-text-muted">
                Sales, manufacturing, dispatch,
                inventory, and master-data indicators.
              </p>
            </div>

            {metrics ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                <MetricCard
                  label="Sales orders"
                  value={formatCount(
                    metrics.total_sales_orders,
                  )}
                  description="Official sales orders recorded on the backend"
                  icon={ShoppingCart}
                  href="/sales/orders"
                />

                <MetricCard
                  label="Pending approvals"
                  value={formatCount(
                    metrics.pending_order_approvals,
                  )}
                  description="Submitted orders awaiting administrative review"
                  icon={ClipboardCheck}
                  href="/sales/orders"
                  emphasis={
                    hasPendingApprovals
                      ? "warning"
                      : "default"
                  }
                />

                <MetricCard
                  label="Approved orders"
                  value={formatCount(
                    metrics.approved_orders,
                  )}
                  description="Orders approved by authorized administrators"
                  icon={CheckCircle2}
                  href="/sales/orders"
                  emphasis="success"
                />

                <MetricCard
                  label="Active production runs"
                  value={formatCount(
                    metrics.active_production_runs,
                  )}
                  description="Manufacturing runs currently in progress"
                  icon={Factory}
                  href="/production/runs"
                />

                <MetricCard
                  label="Completed runs"
                  value={formatCount(
                    metrics.completed_production_runs,
                  )}
                  description="Manufacturing runs completed on the backend"
                  icon={CheckCircle2}
                  href="/production/runs"
                  emphasis="success"
                />

                <MetricCard
                  label="Pending dispatches"
                  value={formatCount(
                    metrics.pending_dispatches,
                  )}
                  description="Dispatch work awaiting completion"
                  icon={Truck}
                  href="/dispatch"
                />

                <MetricCard
                  label="Low-stock items"
                  value={formatCount(
                    metrics.low_stock_items,
                  )}
                  description="Items below backend-configured reorder thresholds"
                  icon={Boxes}
                  href="/inventory/stock-summary"
                  emphasis={
                    hasLowStock
                      ? "warning"
                      : "default"
                  }
                />

                <MetricCard
                  label="Costing pending"
                  value={formatCount(
                    metrics.pending_costing_runs,
                  )}
                  description="Production runs awaiting costing review or finalization"
                  icon={Scale}
                  href="/production/costing"
                  emphasis={
                    hasPendingCosting
                      ? "warning"
                      : "default"
                  }
                />

                <MetricCard
                  label="Customers"
                  value={formatCount(
                    metrics.total_customers,
                  )}
                  description="Customer records in the authorized business scope"
                  icon={Users}
                  href="/customers"
                />

                <MetricCard
                  label="Suppliers"
                  value={formatCount(
                    metrics.total_suppliers,
                  )}
                  description="Supplier records in the authorized business scope"
                  icon={PackageCheck}
                  href="/suppliers"
                />
              </div>
            ) : (
              <div className="rounded-card border border-border bg-surface p-6 text-sm text-text-muted">
                {isOnline
                  ? "Operational metrics are unavailable until the backend dashboard is loaded."
                  : "Operational metrics cannot be retrieved while offline."}
              </div>
            )}
          </section>

          {metrics &&
            (hasOverdueReceivables ||
              hasPendingApprovals ||
              hasLowStock ||
              hasPendingCosting) && (
              <section
                aria-labelledby="owner-review-priorities"
                className="space-y-3"
              >
                <h3
                  id="owner-review-priorities"
                  className="text-base font-semibold text-text-primary"
                >
                  Business review priorities
                </h3>

                <div className="grid gap-3 lg:grid-cols-2">
                  {hasOverdueReceivables && (
                    <Link
                      to="/payments/outstanding"
                      className="flex items-start gap-3 rounded-card border border-warning/30 bg-warning/5 p-4 transition-colors hover:border-warning"
                    >
                      <IndianRupee
                        size={21}
                        className="mt-0.5 shrink-0 text-warning"
                        aria-hidden="true"
                      />

                      <div className="flex-1">
                        <p className="text-sm font-semibold text-text-primary">
                          Overdue receivables
                        </p>

                        <p className="mt-1 text-sm text-text-muted">
                          {formatCurrency(
                            metrics.overdue_amount,
                          )}{" "}
                          is overdue according to
                          backend aging rules.
                        </p>
                      </div>

                      <ArrowRight
                        size={18}
                        className="shrink-0 text-warning"
                        aria-hidden="true"
                      />
                    </Link>
                  )}

                  {hasPendingApprovals && (
                    <Link
                      to="/sales/orders"
                      className="flex items-start gap-3 rounded-card border border-warning/30 bg-warning/5 p-4 transition-colors hover:border-warning"
                    >
                      <ClipboardCheck
                        size={21}
                        className="mt-0.5 shrink-0 text-warning"
                        aria-hidden="true"
                      />

                      <div className="flex-1">
                        <p className="text-sm font-semibold text-text-primary">
                          Orders awaiting approval
                        </p>

                        <p className="mt-1 text-sm text-text-muted">
                          {formatCount(
                            metrics.pending_order_approvals,
                          )}{" "}
                          submitted{" "}
                          {metrics.pending_order_approvals ===
                          1
                            ? "order awaits"
                            : "orders await"}{" "}
                          Factory Admin review.
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
                          Inventory below reorder levels
                        </p>

                        <p className="mt-1 text-sm text-text-muted">
                          {formatCount(
                            metrics.low_stock_items,
                          )}{" "}
                          inventory{" "}
                          {metrics.low_stock_items === 1
                            ? "item requires"
                            : "items require"}{" "}
                          attention.
                        </p>
                      </div>

                      <ArrowRight
                        size={18}
                        className="shrink-0 text-warning"
                        aria-hidden="true"
                      />
                    </Link>
                  )}

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
                          costing review or finalization.
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
            aria-labelledby="owner-navigation"
            className="space-y-4"
          >
            <div>
              <h3
                id="owner-navigation"
                className="text-base font-semibold text-text-primary"
              >
                Business records and reports
              </h3>

              <p className="mt-1 text-sm text-text-muted">
                Open authorized modules for
                read-only inspection.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {NAVIGATION_ITEMS.map((item) => {
                const Icon = item.icon;

                return (
                  <Link
                    key={item.href}
                    to={item.href}
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
                      {item.title}
                    </h4>

                    <p className="mt-2 text-xs leading-5 text-text-muted">
                      {item.description}
                    </p>
                  </Link>
                );
              })}
            </div>
          </section>

          <section
            aria-labelledby="owner-recent-orders"
            className="app-card space-y-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3
                  id="owner-recent-orders"
                  className="text-base font-semibold text-text-primary"
                >
                  Recent sales orders
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Latest official sales orders
                  retrieved from the backend.
                </p>
              </div>

              <Link
                to="/sales/orders"
                className="inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
              >
                View all orders
                <ArrowRight
                  size={16}
                  aria-hidden="true"
                />
              </Link>
            </div>

            {recentOrders.length > 0 ? (
              <div className="app-table-container overflow-x-auto">
                <table className="app-table w-full">
                  <caption className="app-sr-only">
                    Recent sales orders
                  </caption>

                  <thead>
                    <tr>
                      <th scope="col">
                        Order
                      </th>

                      <th scope="col">
                        Customer
                      </th>

                      <th scope="col">
                        Date
                      </th>

                      <th scope="col">
                        Approval status
                      </th>

                      <th
                        scope="col"
                        className="text-right"
                      >
                        Amount
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {recentOrders.map((order) => (
                      <tr key={order.id}>
                        <td className="font-medium text-text-primary">
                          {order.order_number}
                        </td>

                        <td>
                          {order.customer_name}
                        </td>

                        <td className="app-nowrap">
                          {formatDate(
                            order.order_date,
                          )}
                        </td>

                        <td>
                          <StatusBadge
                            status={
                              order.approval_status
                            }
                            category="order"
                            showDot
                          />
                        </td>

                        <td className="app-numeric text-right">
                          {formatCurrency(
                            order.total_amount,
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-control border border-border bg-background px-5 py-8 text-center">
                <ShoppingCart
                  size={32}
                  className="mx-auto text-text-muted"
                  aria-hidden="true"
                />

                <p className="mt-3 text-sm font-medium text-text-primary">
                  No recent sales orders available
                </p>

                <p className="mt-1 text-sm text-text-muted">
                  Official orders appear after
                  successful backend submission.
                </p>
              </div>
            )}
          </section>
        </>
      )}

      <footer className="rounded-card border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck
            size={21}
            className="mt-0.5 shrink-0 text-primary"
            aria-hidden="true"
          />

          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Read-only oversight and data integrity
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Dashboard indicators are supplied
              by backend reporting services.
              GST calculations, payment allocations,
              receivable balances, stock movements,
              production costs, and operational
              status transitions remain
              backend-controlled. Owner access is
              read-only, and navigation from this
              dashboard does not perform business
              transactions.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default OwnerDashboardPage;