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
  BookOpen,
  CheckCircle2,
  ClipboardList,
  FileCheck2,
  FileText,
  IndianRupee,
  Receipt,
  RefreshCw,
  Scale,
  ShieldCheck,
  Wallet,
  WifiOff,
} from "lucide-react";

import { Link } from "react-router-dom";

import { USER_ROLES } from "../../types/auth";

import type {
  PaginatedResponse,
  PaymentStatus,
  TransactionStatus,
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

const RECENT_INVOICE_LIMIT = 5;

interface AccountantDashboardMetrics {
  total_invoiced_amount: string;
  total_collected_amount: string;
  outstanding_amount: string;
  overdue_amount: string;
  posted_invoice_count: number;
  unpaid_invoice_count: number;
  partially_paid_invoice_count: number;
  pending_costing_runs: number;
}

interface AccountantDashboardResponse {
  metrics: AccountantDashboardMetrics;
  generated_at: string;
}

interface RecentInvoice {
  id: UUID;
  invoice_number: string;
  customer_id: UUID;
  customer_name: string;
  invoice_date: string;
  status: TransactionStatus;
  payment_status: PaymentStatus;
  tax_summary: {
    total_amount: string;
  };
  amount_paid: string;
  outstanding_amount: string;
}

interface AccountantDashboardData {
  metrics: AccountantDashboardMetrics;
  recentInvoices: RecentInvoice[];
  generatedAt: string;
}

interface MetricCardProps {
  label: string;
  value: string;
  description: string;
  icon: typeof IndianRupee;
  href?: string;
  emphasis?: "default" | "warning" | "success";
}

interface QuickLink {
  title: string;
  description: string;
  href: string;
  icon: typeof FileText;
}

const QUICK_LINKS: readonly QuickLink[] = [
  {
    title: "GST invoices",
    description:
      "Review posted invoices, tax breakdowns, and payment statuses.",
    href: "/invoices",
    icon: Receipt,
  },
  {
    title: "Payment register",
    description:
      "Inspect recorded customer payments and invoice allocations.",
    href: "/payments",
    icon: Wallet,
  },
  {
    title: "Outstanding receivables",
    description:
      "Review unpaid balances and backend-provided aging information.",
    href: "/payments/outstanding",
    icon: IndianRupee,
  },
  {
    title: "Production costing",
    description:
      "Inspect production expenses, material costs, and costing variances.",
    href: "/production/costing",
    icon: Scale,
  },
  {
    title: "Stock ledger",
    description:
      "Examine recorded inventory movements and valuation history.",
    href: "/inventory/stock-ledger",
    icon: BookOpen,
  },
  {
    title: "Business reports",
    description:
      "Access authorized financial, inventory, and operational reports.",
    href: "/reports",
    icon: BarChart3,
  },
  {
    title: "Sales orders",
    description:
      "Review order approval and fulfillment information.",
    href: "/sales/orders",
    icon: ClipboardList,
  },
  {
    title: "Mock government documents",
    description:
      "Inspect simulated e-Invoice and e-Way Bill records.",
    href: "/government-documents",
    icon: FileCheck2,
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

function isTransactionStatus(
  value: unknown,
): value is TransactionStatus {
  return (
    value === "draft" ||
    value === "posted" ||
    value === "cancelled"
  );
}

function isPaymentStatus(
  value: unknown,
): value is PaymentStatus {
  return (
    value === "pending" ||
    value === "partially_paid" ||
    value === "paid"
  );
}

function validateMetrics(
  value: unknown,
): AccountantDashboardMetrics {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned invalid accounting dashboard metrics.",
    );
  }

  const record = value as Record<string, unknown>;

  const monetaryFields = [
    "total_invoiced_amount",
    "total_collected_amount",
    "outstanding_amount",
    "overdue_amount",
  ] as const;

  const countFields = [
    "posted_invoice_count",
    "unpaid_invoice_count",
    "partially_paid_invoice_count",
    "pending_costing_runs",
  ] as const;

  for (const field of monetaryFields) {
    if (!isNonNegativeDecimalString(record[field])) {
      throw new Error(
        `The backend returned an invalid ${field} amount.`,
      );
    }
  }

  for (const field of countFields) {
    if (!isNonNegativeInteger(record[field])) {
      throw new Error(
        `The backend returned an invalid ${field} count.`,
      );
    }
  }

  return record as unknown as AccountantDashboardMetrics;
}

function validateInvoices(
  value: unknown,
): RecentInvoice[] {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned an invalid invoice response.",
    );
  }

  const response = value as Record<string, unknown>;

  if (
    !Array.isArray(response.items) ||
    !isNonNegativeInteger(response.total)
  ) {
    throw new Error(
      "The backend returned an invalid invoice list.",
    );
  }

  return response.items.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null
    ) {
      throw new Error(
        "The backend returned an invalid invoice record.",
      );
    }

    const invoice = item as Record<string, unknown>;

    if (
      typeof invoice.tax_summary !== "object" ||
      invoice.tax_summary === null
    ) {
      throw new Error(
        "The backend returned an invoice without a tax summary.",
      );
    }

    const taxSummary = invoice.tax_summary as Record<
      string,
      unknown
    >;

    if (
      typeof invoice.id !== "string" ||
      !invoice.id ||
      typeof invoice.invoice_number !== "string" ||
      typeof invoice.customer_id !== "string" ||
      typeof invoice.customer_name !== "string" ||
      typeof invoice.invoice_date !== "string" ||
      !isTransactionStatus(invoice.status) ||
      !isPaymentStatus(invoice.payment_status) ||
      !isNonNegativeDecimalString(
        taxSummary.total_amount,
      ) ||
      !isNonNegativeDecimalString(
        invoice.amount_paid,
      ) ||
      !isNonNegativeDecimalString(
        invoice.outstanding_amount,
      )
    ) {
      throw new Error(
        "The backend returned an incomplete invoice record.",
      );
    }

    return invoice as unknown as RecentInvoice;
  });
}

function validateDashboardResponse(
  value: unknown,
): AccountantDashboardResponse {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    throw new Error(
      "The backend returned an invalid accounting dashboard response.",
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

async function fetchAccountantDashboard(
  signal?: AbortSignal,
): Promise<AccountantDashboardData> {
  const [dashboardResponse, invoicesResponse] =
    await Promise.all([
      apiClient.get<unknown>(
        "/dashboard/accountant",
        { signal },
      ),
      apiClient.get<
        PaginatedResponse<RecentInvoice>
      >("/invoices", {
        query: {
          page: 1,
          page_size: RECENT_INVOICE_LIMIT,
          status: "posted",
          sort_by: "invoice_date",
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
    recentInvoices: validateInvoices(
      invoicesResponse,
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

export function AccountantDashboardPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canAccess =
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR &&
    user.is_active;

  const [dashboard, setDashboard] =
    useState<AccountantDashboardData | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  const requestIdRef = useRef(0);

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

      const requestId = ++requestIdRef.current;

      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError(null);

      try {
        const response =
          await fetchAccountantDashboard(signal);

        if (
          signal?.aborted ||
          requestId !== requestIdRef.current
        ) {
          return;
        }

        setDashboard(response);
      } catch (failure) {
        if (
          signal?.aborted ||
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
          !signal?.aborted &&
          requestId === requestIdRef.current
        ) {
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
      requestIdRef.current += 1;
      setLoading(false);
      setRefreshing(false);
    }

    return () => {
      controller.abort();
      requestIdRef.current += 1;
    };
  }, [canAccess, isOnline, loadDashboard]);

  const metrics = dashboard?.metrics;

  const recentInvoices = useMemo(
    () => dashboard?.recentInvoices ?? [],
    [dashboard],
  );

  const hasPendingCosting =
    (metrics?.pending_costing_runs ?? 0) > 0;

  const hasUnpaidInvoices =
    (metrics?.unpaid_invoice_count ?? 0) > 0;

  const hasOverdueAmount =
    metrics !== undefined &&
    /[1-9]/.test(metrics.overdue_amount);

  if (!canAccess) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Accountant / Auditor Dashboard
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          This dashboard is restricted to active
          Accountant/Auditor accounts.
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
            <Scale
              size={28}
              className="shrink-0 text-primary"
              aria-hidden="true"
            />

            <h2 className="app-page-title">
              Accountant / Auditor Dashboard
            </h2>
          </div>

          <p className="app-page-description">
            Read-only financial oversight of GST
            invoices, collections, receivables,
            production costing, and audit records.
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

      <section
        aria-label="Accountant access level"
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
              Read-only accounting and audit access
            </h3>

            <p className="mt-1 text-sm leading-6 text-text-muted">
              Financial and operational records are
              available for inspection. This role
              cannot approve orders, post invoices,
              change inventory, modify production
              costs, or record customer payments.
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
            The device is offline. Accounting reports,
            invoice records, and dashboard figures
            require a backend connection. Previously
            loaded information may be outdated.
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
              Unable to load accounting dashboard
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
          message="Loading accounting dashboard..."
        />
      ) : (
        <>
          <section
            aria-labelledby="accounting-overview-heading"
            className="space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3
                  id="accounting-overview-heading"
                  className="text-base font-semibold text-text-primary"
                >
                  Financial overview
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Backend-calculated financial
                  balances and invoice counts.
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
                  description="Total invoice value reported by the backend"
                  icon={Receipt}
                  href="/invoices"
                />

                <MetricCard
                  label="Total collected"
                  value={formatCurrency(
                    metrics.total_collected_amount,
                  )}
                  description="Customer collections recorded and recognized by the backend"
                  icon={Wallet}
                  href="/payments"
                  emphasis="success"
                />

                <MetricCard
                  label="Outstanding receivables"
                  value={formatCurrency(
                    metrics.outstanding_amount,
                  )}
                  description="Uncollected invoice balances"
                  icon={IndianRupee}
                  href="/payments/outstanding"
                />

                <MetricCard
                  label="Overdue receivables"
                  value={formatCurrency(
                    metrics.overdue_amount,
                  )}
                  description="Overdue amount based on backend payment terms and aging rules"
                  icon={AlertCircle}
                  href="/payments/outstanding"
                  emphasis={
                    hasOverdueAmount
                      ? "warning"
                      : "default"
                  }
                />

                <MetricCard
                  label="Posted invoices"
                  value={formatCount(
                    metrics.posted_invoice_count,
                  )}
                  description="GST invoices posted in the authorized reporting scope"
                  icon={FileText}
                  href="/invoices"
                />

                <MetricCard
                  label="Unpaid invoices"
                  value={formatCount(
                    metrics.unpaid_invoice_count,
                  )}
                  description="Invoices with no recorded payment allocation"
                  icon={ClipboardList}
                  href="/payments/outstanding"
                  emphasis={
                    hasUnpaidInvoices
                      ? "warning"
                      : "default"
                  }
                />

                <MetricCard
                  label="Partially paid invoices"
                  value={formatCount(
                    metrics.partially_paid_invoice_count,
                  )}
                  description="Invoices with outstanding balances after partial collections"
                  icon={IndianRupee}
                  href="/payments/outstanding"
                />

                <MetricCard
                  label="Production costing pending"
                  value={formatCount(
                    metrics.pending_costing_runs,
                  )}
                  description="Production runs requiring costing review or finalization"
                  icon={Scale}
                  href="/production/costing"
                  emphasis={
                    hasPendingCosting
                      ? "warning"
                      : "default"
                  }
                />
              </div>
            ) : (
              <div className="rounded-card border border-border bg-surface p-6 text-sm text-text-muted">
                {isOnline
                  ? "Accounting metrics are unavailable until the backend dashboard is loaded."
                  : "Accounting metrics cannot be retrieved while offline."}
              </div>
            )}
          </section>

          {metrics &&
            (hasOverdueAmount ||
              hasPendingCosting) && (
              <section
                aria-labelledby="accounting-attention-heading"
                className="space-y-3"
              >
                <h3
                  id="accounting-attention-heading"
                  className="text-base font-semibold text-text-primary"
                >
                  Review priorities
                </h3>

                <div className="grid gap-3 lg:grid-cols-2">
                  {hasOverdueAmount && (
                    <Link
                      to="/payments/outstanding"
                      className="flex items-start gap-3 rounded-card border border-warning/30 bg-warning/5 p-4 transition-colors hover:border-warning"
                    >
                      <AlertCircle
                        size={21}
                        className="mt-0.5 shrink-0 text-warning"
                        aria-hidden="true"
                      />

                      <div className="flex-1">
                        <p className="text-sm font-semibold text-text-primary">
                          Overdue customer receivables
                        </p>

                        <p className="mt-1 text-sm text-text-muted">
                          {formatCurrency(
                            metrics.overdue_amount,
                          )}{" "}
                          is classified as overdue
                          by the backend.
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
                          Production costing review
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
                </div>
              </section>
            )}

          <section
            aria-labelledby="accountant-quick-links"
            className="space-y-4"
          >
            <div>
              <h3
                id="accountant-quick-links"
                className="text-base font-semibold text-text-primary"
              >
                Accounting and audit records
              </h3>

              <p className="mt-1 text-sm text-text-muted">
                Open authorized modules for
                inspection and reporting.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {QUICK_LINKS.map((item) => {
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
            aria-labelledby="accountant-recent-invoices"
            className="app-card space-y-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3
                  id="accountant-recent-invoices"
                  className="text-base font-semibold text-text-primary"
                >
                  Recent posted GST invoices
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Latest posted invoices retrieved
                  from the backend.
                </p>
              </div>

              <Link
                to="/invoices"
                className="inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
              >
                View all invoices
                <ArrowRight
                  size={16}
                  aria-hidden="true"
                />
              </Link>
            </div>

            {recentInvoices.length > 0 ? (
              <div className="app-table-container overflow-x-auto">
                <table className="app-table w-full">
                  <caption className="app-sr-only">
                    Recent posted GST invoices
                  </caption>

                  <thead>
                    <tr>
                      <th scope="col">
                        Invoice
                      </th>

                      <th scope="col">
                        Customer
                      </th>

                      <th scope="col">
                        Date
                      </th>

                      <th scope="col">
                        Payment status
                      </th>

                      <th
                        scope="col"
                        className="text-right"
                      >
                        Invoice total
                      </th>

                      <th
                        scope="col"
                        className="text-right"
                      >
                        Outstanding
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {recentInvoices.map(
                      (invoice) => (
                        <tr key={invoice.id}>
                          <td>
                            <Link
                              to={`/invoices/${encodeURIComponent(invoice.id)}`}
                              className="font-medium text-accent hover:underline"
                            >
                              {invoice.invoice_number}
                            </Link>
                          </td>

                          <td>
                            {invoice.customer_name}
                          </td>

                          <td className="app-nowrap">
                            {formatDate(
                              invoice.invoice_date,
                            )}
                          </td>

                          <td>
                            <StatusBadge
                              status={
                                invoice.payment_status
                              }
                              category="payment"
                              showDot
                            />
                          </td>

                          <td className="app-numeric text-right">
                            {formatCurrency(
                              invoice.tax_summary
                                .total_amount,
                            )}
                          </td>

                          <td className="app-numeric text-right">
                            {formatCurrency(
                              invoice.outstanding_amount,
                            )}
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-control border border-border bg-background px-5 py-8 text-center">
                <Receipt
                  size={32}
                  className="mx-auto text-text-muted"
                  aria-hidden="true"
                />

                <p className="mt-3 text-sm font-medium text-text-primary">
                  No posted invoices available
                </p>

                <p className="mt-1 text-sm text-text-muted">
                  Posted GST invoices appear after
                  successful backend posting.
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
              Financial integrity and auditability
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              All monetary figures, GST components,
              payment allocations, receivable
              balances, overdue classifications,
              inventory valuations, and production
              costs are supplied by the backend.
              This dashboard performs no financial
              calculations or mutations. Accounting
              records and audit trails remain
              subject to backend authorization
              and validation.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default AccountantDashboardPage;