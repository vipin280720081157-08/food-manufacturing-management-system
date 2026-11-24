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
  ClipboardCheck,
  ClipboardList,
  Factory,
  FileText,
  IndianRupee,
  PackageCheck,
  RefreshCw,
  ShoppingCart,
  Truck,
  Users,
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

interface AdminDashboardMetrics {
  total_customers: number;
  total_suppliers: number;
  pending_order_approvals: number;
  approved_orders: number;
  pending_dispatches: number;
  low_stock_items: number;
  active_production_runs: number;
  outstanding_amount: string;
}

interface RecentSalesOrder {
  id: UUID;
  order_number: string;
  customer_id: UUID;
  customer_name: string;
  salesman_id: UUID;
  salesman_name: string;
  order_date: string;
  approval_status: OrderApprovalStatus;
  total_amount: string;
}

interface AdminDashboardResponse {
  metrics: AdminDashboardMetrics;
  recent_orders: RecentSalesOrder[];
  generated_at: string;
}

interface DashboardData {
  metrics: AdminDashboardMetrics;
  recentOrders: RecentSalesOrder[];
  generatedAt: string;
}

interface DashboardMetricCardProps {
  label: string;
  value: string;
  description: string;
  icon: typeof ShoppingCart;
  href?: string;
  emphasis?: "default" | "warning" | "success";
}

interface QuickAction {
  label: string;
  description: string;
  href: string;
  icon: typeof ShoppingCart;
}

const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    label: "Review sales orders",
    description:
      "Approve or reject submitted customer orders.",
    href: "/sales/orders/review",
    icon: ClipboardCheck,
  },
  {
    label: "Manage purchasing",
    description:
      "Create and review purchase orders.",
    href: "/purchasing/purchases",
    icon: ShoppingCart,
  },
  {
    label: "Record goods receipts",
    description:
      "Record accepted and rejected incoming materials.",
    href: "/purchasing/goods-receipts",
    icon: PackageCheck,
  },
  {
    label: "Manage inventory",
    description:
      "Review stock balances and inventory availability.",
    href: "/inventory/stock-summary",
    icon: Boxes,
  },
  {
    label: "Production runs",
    description:
      "Review manufacturing activity and production progress.",
    href: "/production/runs",
    icon: Factory,
  },
  {
    label: "GST invoices",
    description:
      "Review and post invoices for approved sales orders.",
    href: "/invoices",
    icon: FileText,
  },
  {
    label: "Dispatch management",
    description:
      "Manage dispatches against eligible posted invoices.",
    href: "/dispatch",
    icon: Truck,
  },
  {
    label: "Payment collections",
    description:
      "Record collections and review customer receivables.",
    href: "/payments",
    icon: IndianRupee,
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

function isDecimalString(
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
): AdminDashboardMetrics {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned invalid administrative dashboard metrics.",
    );
  }

  const record = value as Record<string, unknown>;

  const countFields = [
    "total_customers",
    "total_suppliers",
    "pending_order_approvals",
    "approved_orders",
    "pending_dispatches",
    "low_stock_items",
    "active_production_runs",
  ] as const;

  for (const field of countFields) {
    if (!isNonNegativeInteger(record[field])) {
      throw new Error(
        `The backend returned an invalid ${field} metric.`,
      );
    }
  }

  if (!isDecimalString(record.outstanding_amount)) {
    throw new Error(
      "The backend returned an invalid outstanding amount.",
    );
  }

  return record as unknown as AdminDashboardMetrics;
}

function validateRecentOrders(
  value: unknown,
): RecentSalesOrder[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "The backend returned an invalid recent orders list.",
    );
  }

  return value.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null
    ) {
      throw new Error(
        "The backend returned an invalid recent order.",
      );
    }

    const order = item as Record<string, unknown>;
    const totalAmount =
      typeof order.total_amount === "string"
        ? order.total_amount
        : order.grand_total;

    if (
      typeof order.id !== "string" ||
      !order.id ||
      typeof order.order_number !== "string" ||
      typeof order.customer_id !== "string" ||
      typeof order.customer_name !== "string" ||
      typeof order.salesman_id !== "string" ||
      typeof order.salesman_name !== "string" ||
      typeof order.order_date !== "string" ||
      !isOrderApprovalStatus(
        order.approval_status,
      ) ||
      !isDecimalString(totalAmount)
    ) {
      throw new Error(
        "The backend returned an incomplete recent order.",
      );
    }

    return {
      ...order,
      total_amount: totalAmount,
    } as unknown as RecentSalesOrder;
  });
}

function validateDashboardResponse(
  value: unknown,
): AdminDashboardResponse {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned an invalid administrative dashboard response.",
    );
  }

  const response = value as Record<string, unknown>;

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
    recent_orders: validateRecentOrders(
      response.recent_orders,
    ),
    generated_at: response.generated_at,
  };
}

function validateOrdersResponse(
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

  return validateRecentOrders(response.items);
}

async function fetchDashboardData(
  signal?: AbortSignal,
): Promise<DashboardData> {
  const [dashboardResponse, ordersResponse] =
    await Promise.all([
      apiClient.get<unknown>(
        "/dashboard/admin",
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
    recentOrders: validateOrdersResponse(
      ordersResponse,
    ),
    generatedAt:
      validatedDashboard.generated_at,
  };
}

function DashboardMetricCard({
  label,
  value,
  description,
  icon: Icon,
  href,
  emphasis = "default",
}: DashboardMetricCardProps) {
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

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-IN").format(
    value,
  );
}

export function AdminDashboardPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canAccess =
    user?.role === USER_ROLES.FACTORY_ADMIN &&
    user.is_active;

  const [dashboard, setDashboard] =
    useState<DashboardData | null>(null);

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
          await fetchDashboardData(signal);

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

  const recentOrders = useMemo(
    () => dashboard?.recentOrders ?? [],
    [dashboard],
  );

  const hasPendingApprovals =
    (metrics?.pending_order_approvals ?? 0) > 0;

  const hasLowStock =
    (metrics?.low_stock_items ?? 0) > 0;

  if (!canAccess) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Factory Admin Dashboard
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          This dashboard is restricted to active
          Factory Admin accounts.
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
              Factory Admin Dashboard
            </h2>
          </div>

          <p className="app-page-description">
            Operational overview of sales approvals,
            purchasing, inventory, production,
            dispatch, and collections.
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
            The device is offline. Administrative
            operations and dashboard refreshes require
            a backend connection. Any previously
            displayed figures may be outdated.
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
              Unable to load dashboard data
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
          message="Loading administrative dashboard..."
        />
      ) : (
        <>
          <section
            aria-labelledby="admin-overview-heading"
            className="space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3
                  id="admin-overview-heading"
                  className="text-base font-semibold text-text-primary"
                >
                  Operational overview
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Backend-calculated operational
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
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <DashboardMetricCard
                  label="Pending order approvals"
                  value={formatCount(
                    metrics.pending_order_approvals,
                  )}
                  description="Submitted sales orders awaiting administrative review"
                  icon={ClipboardCheck}
                  href="/sales/orders/review"
                  emphasis={
                    hasPendingApprovals
                      ? "warning"
                      : "default"
                  }
                />

                <DashboardMetricCard
                  label="Approved orders"
                  value={formatCount(
                    metrics.approved_orders,
                  )}
                  description="Sales orders approved by authorized administrators"
                  icon={CheckCircle2}
                  href="/sales/orders"
                  emphasis="success"
                />

                <DashboardMetricCard
                  label="Pending dispatches"
                  value={formatCount(
                    metrics.pending_dispatches,
                  )}
                  description="Dispatch work awaiting completion"
                  icon={Truck}
                  href="/dispatch"
                  emphasis="warning"
                />

                <DashboardMetricCard
                  label="Low-stock items"
                  value={formatCount(
                    metrics.low_stock_items,
                  )}
                  description="Inventory items identified by backend reorder rules"
                  icon={Boxes}
                  href="/inventory/stock-summary"
                  emphasis={
                    hasLowStock
                      ? "warning"
                      : "default"
                  }
                />

                <DashboardMetricCard
                  label="Active production runs"
                  value={formatCount(
                    metrics.active_production_runs,
                  )}
                  description="Manufacturing runs currently in progress"
                  icon={Factory}
                  href="/production/runs"
                />

                <DashboardMetricCard
                  label="Outstanding receivables"
                  value={formatCurrency(
                    metrics.outstanding_amount,
                  )}
                  description="Uncollected customer invoice balances"
                  icon={IndianRupee}
                  href="/payments/outstanding"
                />

                <DashboardMetricCard
                  label="Customers"
                  value={formatCount(
                    metrics.total_customers,
                  )}
                  description="Customer records included in the administrative scope"
                  icon={Users}
                  href="/customers"
                />

                <DashboardMetricCard
                  label="Suppliers"
                  value={formatCount(
                    metrics.total_suppliers,
                  )}
                  description="Supplier records included in the administrative scope"
                  icon={ClipboardList}
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
            (hasPendingApprovals || hasLowStock) && (
              <section
                aria-labelledby="admin-attention-heading"
                className="space-y-3"
              >
                <h3
                  id="admin-attention-heading"
                  className="text-base font-semibold text-text-primary"
                >
                  Items requiring attention
                </h3>

                <div className="grid gap-3 lg:grid-cols-2">
                  {hasPendingApprovals && (
                    <Link
                      to="/sales/orders/review"
                      className="flex items-start gap-3 rounded-card border border-warning/30 bg-warning/5 p-4 transition-colors hover:border-warning"
                    >
                      <ClipboardCheck
                        size={21}
                        className="mt-0.5 shrink-0 text-warning"
                        aria-hidden="true"
                      />

                      <div className="flex-1">
                        <p className="text-sm font-semibold text-text-primary">
                          Sales approvals pending
                        </p>

                        <p className="mt-1 text-sm text-text-muted">
                          {formatCount(
                            metrics.pending_order_approvals,
                          )}{" "}
                          submitted{" "}
                          {metrics.pending_order_approvals ===
                          1
                            ? "order requires"
                            : "orders require"}{" "}
                          administrative review.
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
                          Low-stock inventory
                        </p>

                        <p className="mt-1 text-sm text-text-muted">
                          {formatCount(
                            metrics.low_stock_items,
                          )}{" "}
                          inventory{" "}
                          {metrics.low_stock_items === 1
                            ? "item is"
                            : "items are"}{" "}
                          below the applicable reorder
                          threshold.
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
            aria-labelledby="admin-quick-actions"
            className="space-y-4"
          >
            <div>
              <h3
                id="admin-quick-actions"
                className="text-base font-semibold text-text-primary"
              >
                Management actions
              </h3>

              <p className="mt-1 text-sm text-text-muted">
                Open the relevant module to review
                or perform authorized operations.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
                      {action.label}
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
            aria-labelledby="admin-recent-orders"
            className="app-card space-y-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3
                  id="admin-recent-orders"
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
                        Salesman
                      </th>

                      <th scope="col">
                        Date
                      </th>

                      <th scope="col">
                        Approval
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

                        <td>
                          {order.salesman_name}
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
                <ClipboardList
                  size={32}
                  className="mx-auto text-text-muted"
                  aria-hidden="true"
                />

                <p className="mt-3 text-sm font-medium text-text-primary">
                  No recent sales orders available
                </p>

                <p className="mt-1 text-sm text-text-muted">
                  Orders appear after they have been
                  recorded by the backend.
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
              Backend-controlled operations
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Dashboard indicators are retrieved
              from backend records. Sales approval,
              purchase and goods receipt posting,
              stock movements, production accounting,
              GST invoice calculation, dispatch
              allocation, payment collection, and
              audit history remain authoritative
              on the backend. Dashboard navigation
              does not itself perform business
              transactions.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default AdminDashboardPage;
