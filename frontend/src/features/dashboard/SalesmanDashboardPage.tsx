import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  Clock3,
  FilePlus2,
  RefreshCw,
  ShoppingCart,
  Users,
  Wifi,
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
} from "../../utils/formatters";

interface SalesmanDashboardMetrics {
  total_customers: number;
  total_orders: number;
  pending_orders: number;
  approved_orders: number;
  rejected_orders: number;
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

interface DashboardData {
  metrics: SalesmanDashboardMetrics;
  recentOrders: RecentSalesOrder[];
}

const RECENT_ORDER_LIMIT = 5;

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function validateMetrics(
  value: unknown,
): SalesmanDashboardMetrics {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned invalid dashboard metrics.",
    );
  }

  const record = value as Record<string, unknown>;

  const requiredFields = [
    "total_customers",
    "total_orders",
    "pending_orders",
    "approved_orders",
    "rejected_orders",
  ] as const;

  for (const field of requiredFields) {
    if (!isNonNegativeInteger(record[field])) {
      throw new Error(
        `The backend returned an invalid ${field} metric.`,
      );
    }
  }

  return record as unknown as SalesmanDashboardMetrics;
}

function validateRecentOrders(
  value: unknown,
): RecentSalesOrder[] {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned an invalid order list.",
    );
  }

  const response = value as Record<string, unknown>;

  if (!Array.isArray(response.items)) {
    throw new Error(
      "The backend returned an invalid order list.",
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
      typeof order.order_number !== "string" ||
      typeof order.customer_id !== "string" ||
      typeof order.customer_name !== "string" ||
      typeof order.order_date !== "string" ||
      typeof order.approval_status !== "string" ||
      typeof order.total_amount !== "string"
    ) {
      throw new Error(
        "The backend returned an incomplete sales order.",
      );
    }

    return order as unknown as RecentSalesOrder;
  });
}

async function fetchDashboardData(
  signal?: AbortSignal,
): Promise<DashboardData> {
  const [metricsResponse, ordersResponse] =
    await Promise.all([
      apiClient.get<unknown>(
        "/dashboard/salesman",
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

  return {
    metrics: validateMetrics(metricsResponse),
    recentOrders: validateRecentOrders(
      ordersResponse,
    ),
  };
}

interface MetricCardProps {
  title: string;
  value: number;
  description: string;
  icon: typeof ShoppingCart;
  iconClassName?: string;
}

function MetricCard({
  title,
  value,
  description,
  icon: Icon,
  iconClassName = "text-primary",
}: MetricCardProps) {
  return (
    <article className="rounded-card border border-border bg-surface p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-text-muted">
          {title}
        </p>

        <div className="rounded-control bg-background p-2.5">
          <Icon
            size={20}
            className={iconClassName}
            aria-hidden="true"
          />
        </div>
      </div>

      <p className="app-numeric mt-3 text-3xl font-bold text-text-primary">
        {new Intl.NumberFormat("en-IN").format(value)}
      </p>

      <p className="mt-2 text-xs leading-5 text-text-muted">
        {description}
      </p>
    </article>
  );
}

export function SalesmanDashboardPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canAccess =
    user?.role === USER_ROLES.SALESMAN &&
    user.is_active;

  const [dashboard, setDashboard] =
    useState<DashboardData | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [error, setError] =
    useState<string | null>(null);

  const [lastUpdated, setLastUpdated] =
    useState<string | null>(null);

  const loadDashboard = useCallback(
    async (
      signal?: AbortSignal,
      isRefresh = false,
    ): Promise<void> => {
      if (!canAccess) {
        setDashboard(null);
        setLoading(false);
        return;
      }

      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError(null);

      try {
        const response = await fetchDashboardData(
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setDashboard(response);
        setLastUpdated(new Date().toISOString());
      } catch (failure) {
        if (signal?.aborted) {
          return;
        }

        setError(getApiErrorMessage(failure));

        if (!isRefresh) {
          setDashboard(null);
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

    if (isOnline) {
      void loadDashboard(controller.signal);
    } else {
      setLoading(false);
    }

    return () => controller.abort();
  }, [isOnline, loadDashboard]);

  const recentOrders = useMemo(
    () => dashboard?.recentOrders ?? [],
    [dashboard],
  );

  const metrics = dashboard?.metrics;

  if (!canAccess) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Salesman Dashboard
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          This dashboard is available only to active
          Salesman accounts.
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
          <h2 className="app-page-title">
            Salesman Dashboard
          </h2>

          <p className="app-page-description">
            Sales orders, assigned customer activity,
            and access to online and offline order capture.
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

          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </header>

      <section
        aria-label="Connection status"
        className={`rounded-card border p-4 ${
          isOnline
            ? "border-success/25 bg-success/5"
            : "border-warning/30 bg-warning/5"
        }`}
      >
        <div className="flex items-start gap-3">
          {isOnline ? (
            <Wifi
              size={21}
              className="mt-0.5 shrink-0 text-success"
              aria-hidden="true"
            />
          ) : (
            <WifiOff
              size={21}
              className="mt-0.5 shrink-0 text-warning"
              aria-hidden="true"
            />
          )}

          <div className="flex-1">
            <h3 className="text-sm font-semibold text-text-primary">
              {isOnline
                ? "Device is online"
                : "Device is offline"}
            </h3>

            <p className="mt-1 text-sm leading-6 text-text-muted">
              {isOnline
                ? "Backend reports can be refreshed while the service is reachable. Offline order drafts and synchronization status are managed separately."
                : "Backend dashboard figures cannot be refreshed while offline. Previously loaded figures may be outdated. Offline order capture remains available through locally stored reference data."}
            </p>

            <Link
              to="/offline/orders"
              className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
            >
              Open offline orders
              <ArrowRight
                size={16}
                aria-hidden="true"
              />
            </Link>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="salesman-quick-actions"
        className="space-y-3"
      >
        <h3
          id="salesman-quick-actions"
          className="text-base font-semibold text-text-primary"
        >
          Quick actions
        </h3>

        <div className="grid gap-4 md:grid-cols-3">
          <Link
            to="/sales/orders/new"
            aria-disabled={!isOnline}
            onClick={(event) => {
              if (!isOnline) {
                event.preventDefault();
              }
            }}
            className={`group rounded-card border border-border bg-surface p-5 shadow-card transition-colors ${
              isOnline
                ? "hover:border-accent"
                : "cursor-not-allowed opacity-60"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="rounded-control bg-primary/10 p-3 text-primary">
                <FilePlus2
                  size={22}
                  aria-hidden="true"
                />
              </div>

              <ArrowRight
                size={18}
                className="text-text-muted group-hover:text-accent"
                aria-hidden="true"
              />
            </div>

            <h4 className="mt-4 font-semibold text-text-primary">
              Create online order
            </h4>

            <p className="mt-2 text-sm leading-6 text-text-muted">
              Submit a customer sales order for
              backend validation and review.
            </p>

            {!isOnline && (
              <p className="mt-2 text-xs font-medium text-warning">
                Online connection required
              </p>
            )}
          </Link>

          <Link
            to="/offline/orders"
            className="group rounded-card border border-border bg-surface p-5 shadow-card transition-colors hover:border-accent"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="rounded-control bg-primary/10 p-3 text-primary">
                <WifiOff
                  size={22}
                  aria-hidden="true"
                />
              </div>

              <ArrowRight
                size={18}
                className="text-text-muted group-hover:text-accent"
                aria-hidden="true"
              />
            </div>

            <h4 className="mt-4 font-semibold text-text-primary">
              Offline orders
            </h4>

            <p className="mt-2 text-sm leading-6 text-text-muted">
              Capture local drafts, review pending
              submissions, and resolve synchronization
              issues.
            </p>
          </Link>

          <Link
            to="/sales/orders"
            className="group rounded-card border border-border bg-surface p-5 shadow-card transition-colors hover:border-accent"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="rounded-control bg-primary/10 p-3 text-primary">
                <ClipboardList
                  size={22}
                  aria-hidden="true"
                />
              </div>

              <ArrowRight
                size={18}
                className="text-text-muted group-hover:text-accent"
                aria-hidden="true"
              />
            </div>

            <h4 className="mt-4 font-semibold text-text-primary">
              Sales orders
            </h4>

            <p className="mt-2 text-sm leading-6 text-text-muted">
              Review submitted orders and their
              backend-confirmed approval statuses.
            </p>
          </Link>
        </div>
      </section>

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
              Unable to refresh dashboard
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
          message="Loading sales dashboard..."
        />
      ) : (
        <>
          <section
            aria-labelledby="salesman-metrics"
            className="space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3
                id="salesman-metrics"
                className="text-base font-semibold text-text-primary"
              >
                Sales overview
              </h3>

              {lastUpdated && (
                <p className="text-xs text-text-muted">
                  Last refreshed:{" "}
                  {new Date(
                    lastUpdated,
                  ).toLocaleString("en-IN")}
                </p>
              )}
            </div>

            {metrics ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                <MetricCard
                  title="Assigned customers"
                  value={metrics.total_customers}
                  description="Customers included in the authorized dashboard scope"
                  icon={Users}
                />

                <MetricCard
                  title="Total orders"
                  value={metrics.total_orders}
                  description="Official sales orders recorded on the backend"
                  icon={ShoppingCart}
                />

                <MetricCard
                  title="Pending review"
                  value={metrics.pending_orders}
                  description="Orders awaiting administrative review"
                  icon={Clock3}
                  iconClassName="text-warning"
                />

                <MetricCard
                  title="Approved"
                  value={metrics.approved_orders}
                  description="Orders approved by the Factory Admin"
                  icon={CheckCircle2}
                  iconClassName="text-success"
                />

                <MetricCard
                  title="Rejected"
                  value={metrics.rejected_orders}
                  description="Orders rejected during administrative review"
                  icon={AlertCircle}
                  iconClassName="text-error"
                />
              </div>
            ) : (
              <div className="rounded-card border border-border bg-surface p-6 text-sm text-text-muted">
                {isOnline
                  ? "Sales metrics are unavailable until the backend dashboard is loaded."
                  : "Sales metrics are unavailable offline. Local drafts are managed in Offline Orders."}
              </div>
            )}
          </section>

          <section
            aria-labelledby="recent-sales-orders"
            className="app-card space-y-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3
                  id="recent-sales-orders"
                  className="text-base font-semibold text-text-primary"
                >
                  Recent sales orders
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Latest official orders returned
                  for the authenticated Salesman.
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
                    Recent official sales orders
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
                  No recent orders available
                </p>

                <p className="mt-1 text-sm text-text-muted">
                  Official orders appear after the
                  backend accepts a submission.
                  Unsynchronized local orders are
                  not included.
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
              Official orders and offline drafts
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Dashboard metrics and recent orders
              reflect backend-confirmed records only.
              Offline drafts and pending synchronization
              items remain separate until the backend
              accepts them. Administrative approval,
              GST calculations, stock validation,
              invoicing, and dispatch are enforced
              by the backend.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default SalesmanDashboardPage;