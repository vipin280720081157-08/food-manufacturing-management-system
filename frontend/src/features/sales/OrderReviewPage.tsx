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
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  RefreshCw,
  Search,
  WifiOff,
  XCircle,
} from "lucide-react";

import { Link } from "react-router-dom";

import type {
  OrderApprovalStatus,
  OrderFulfillmentStatus,
  PaginatedResponse,
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
import { ConfirmDialog } from "../../components/common/ConfirmDialog";

import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatQuantity,
} from "../../utils/formatters";

const PAGE_SIZE = 20;
const MAX_REJECTION_REASON_LENGTH = 1000;

type ReviewAction = "approve" | "reject";
type ReviewFilter = "submitted" | "approved" | "rejected" | "all";

interface SalesOrderReviewItem {
  id: UUID;
  order_number: string;
  customer_id: UUID;
  customer_name: string;
  salesman_id: UUID;
  salesman_name: string;
  order_date: string;
  approval_status: OrderApprovalStatus;
  fulfillment_status: OrderFulfillmentStatus;
  item_count: number;
  total_quantity: string;
  taxable_amount: string;
  total_tax: string;
  total_amount: string;
  notes: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string | null;
}

interface SalesOrderReviewLine {
  id: UUID;
  product_id: UUID;
  product_code: string;
  product_name: string;
  quantity: string;
  unit: string;
  unit_price: string;
  taxable_amount: string;
  gst_rate: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  line_total: string;
}

interface SalesOrderReviewDetails extends SalesOrderReviewItem {
  items: SalesOrderReviewLine[];
}

interface ReviewFilters {
  page: number;
  search: string;
  approvalStatus: ReviewFilter;
  dateFrom: string;
  dateTo: string;
}

interface PendingDecision {
  orderId: UUID;
  orderNumber: string;
  action: ReviewAction;
}

const REVIEW_FILTERS: ReadonlyArray<{
  value: ReviewFilter;
  label: string;
}> = [
  { value: "submitted", label: "Awaiting review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All statuses" },
];

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

async function fetchReviewOrders(
  filters: ReviewFilters,
  signal?: AbortSignal,
): Promise<PaginatedResponse<SalesOrderReviewItem>> {
  return apiClient.get<
    PaginatedResponse<SalesOrderReviewItem>
  >("/sales/orders", {
    query: {
      page: filters.page,
      page_size: PAGE_SIZE,
      search: filters.search || undefined,
      approval_status:
        filters.approvalStatus === "all"
          ? undefined
          : filters.approvalStatus,
      date_from: filters.dateFrom || undefined,
      date_to: filters.dateTo || undefined,
    },
    signal,
  });
}

async function fetchOrderDetails(
  orderId: UUID,
  signal?: AbortSignal,
): Promise<SalesOrderReviewDetails> {
  return apiClient.get<SalesOrderReviewDetails>(
    `/sales/orders/${encodeURIComponent(orderId)}`,
    { signal },
  );
}

async function approveOrder(
  orderId: UUID,
  idempotencyKey: string,
): Promise<SalesOrderReviewDetails> {
  return apiClient.post<SalesOrderReviewDetails>(
    `/sales/orders/${encodeURIComponent(orderId)}/approve`,
    {},
    { idempotencyKey },
  );
}

async function rejectOrder(
  orderId: UUID,
  reason: string,
  idempotencyKey: string,
): Promise<SalesOrderReviewDetails> {
  return apiClient.post<SalesOrderReviewDetails>(
    `/sales/orders/${encodeURIComponent(orderId)}/reject`,
    { rejection_reason: reason },
    { idempotencyKey },
  );
}

interface OrderDetailsPanelProps {
  orderId: UUID;
  onClose: () => void;
  onApprove: (order: SalesOrderReviewDetails) => void;
  onReject: (order: SalesOrderReviewDetails) => void;
  canReview: boolean;
  isOnline: boolean;
}

function OrderDetailsPanel({
  orderId,
  onClose,
  onApprove,
  onReject,
  canReview,
  isOnline,
}: OrderDetailsPanelProps) {
  const [order, setOrder] =
    useState<SalesOrderReviewDetails | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOrder = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoading(true);
      setError(null);
      setOrder(null);

      try {
        const response = await fetchOrderDetails(
          orderId,
          signal,
        );

        if (!signal?.aborted) {
          setOrder(response);
        }
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
    [orderId],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadOrder(controller.signal);

    return () => controller.abort();
  }, [loadOrder]);

  return (
    <section
      aria-labelledby="review-order-details-title"
      className="app-card space-y-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3
            id="review-order-details-title"
            className="text-lg font-semibold text-text-primary"
          >
            {order?.order_number ?? "Order details"}
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            Review the backend-recorded order before making
            an approval decision.
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="app-button app-button-secondary"
        >
          Close details
        </button>
      </div>

      {loading && (
        <LoadingState
          variant="section"
          message="Loading order details..."
        />
      )}

      {error && (
        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          <p>{error}</p>

          <button
            type="button"
            onClick={() => {
              void loadOrder();
            }}
            className="mt-2 text-sm font-medium underline"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && order && (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <StatusBadge
              status={order.approval_status}
              category="order"
              showDot
            />

            <StatusBadge
              status={order.fulfillment_status}
              category="fulfillment"
              showDot
            />
          </div>

          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ["Customer", order.customer_name],
              ["Salesman", order.salesman_name],
              ["Order date", formatDate(order.order_date)],
              ["Items", String(order.item_count)],
              [
                "Total quantity",
                formatQuantity(order.total_quantity),
              ],
              [
                "Submitted",
                order.submitted_at
                  ? formatDateTime(order.submitted_at)
                  : "—",
              ],
              [
                "Approved",
                order.approved_at
                  ? formatDateTime(order.approved_at)
                  : "—",
              ],
              [
                "Rejected",
                order.rejected_at
                  ? formatDateTime(order.rejected_at)
                  : "—",
              ],
              ["Created", formatDateTime(order.created_at)],
            ].map(([label, value]) => (
              <div
                key={label}
                className="border-b border-border pb-3"
              >
                <dt className="text-xs text-text-muted">
                  {label}
                </dt>

                <dd className="mt-1 break-words text-sm font-medium text-text-primary">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {order.notes && (
            <div>
              <h4 className="text-sm font-semibold text-text-primary">
                Sales order notes
              </h4>

              <p className="mt-2 whitespace-pre-wrap rounded-control bg-background p-4 text-sm text-text-muted">
                {order.notes}
              </p>
            </div>
          )}

          {order.rejection_reason && (
            <div className="app-alert app-alert-warning">
              <p className="font-semibold">
                Recorded rejection reason
              </p>

              <p className="mt-1 whitespace-pre-wrap">
                {order.rejection_reason}
              </p>
            </div>
          )}

          <div>
            <h4 className="mb-3 text-base font-semibold text-text-primary">
              Order items
            </h4>

            <div className="app-table-container">
              <table className="app-table w-full">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col" className="text-right">
                      Quantity
                    </th>
                    <th scope="col" className="text-right">
                      Unit price
                    </th>
                    <th scope="col" className="text-right">
                      Taxable amount
                    </th>
                    <th scope="col" className="text-right">
                      GST
                    </th>
                    <th scope="col" className="text-right">
                      Line total
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {order.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <p className="font-medium">
                          {item.product_name}
                        </p>

                        <p className="mt-1 text-xs text-text-muted">
                          {item.product_code}
                        </p>
                      </td>

                      <td className="app-numeric whitespace-nowrap text-right">
                        {formatQuantity(item.quantity)}{" "}
                        {item.unit}
                      </td>

                      <td className="app-numeric whitespace-nowrap text-right">
                        {formatCurrency(item.unit_price)}
                      </td>

                      <td className="app-numeric whitespace-nowrap text-right">
                        {formatCurrency(item.taxable_amount)}
                      </td>

                      <td className="app-numeric whitespace-nowrap text-right">
                        {item.gst_rate}%
                      </td>

                      <td className="app-numeric whitespace-nowrap text-right">
                        {formatCurrency(item.line_total)}
                      </td>
                    </tr>
                  ))}

                  {order.items.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="py-6 text-center text-text-muted"
                      >
                        No order items were returned.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="ml-auto max-w-sm rounded-control border border-border p-4">
            <dl className="space-y-3">
              {[
                ["Taxable amount", order.taxable_amount],
                ["Total GST", order.total_tax],
                ["Order total", order.total_amount],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-4"
                >
                  <dt className="text-sm text-text-muted">
                    {label}
                  </dt>

                  <dd className="app-numeric text-sm font-semibold text-text-primary">
                    {formatCurrency(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {canReview &&
            order.approval_status === "submitted" && (
              <div className="flex flex-wrap justify-end gap-3 border-t border-border pt-5">
                <button
                  type="button"
                  onClick={() => onReject(order)}
                  disabled={!isOnline}
                  className="app-button app-button-danger inline-flex items-center gap-2"
                >
                  <XCircle size={17} aria-hidden="true" />
                  Reject order
                </button>

                <button
                  type="button"
                  onClick={() => onApprove(order)}
                  disabled={!isOnline || order.items.length === 0}
                  className="app-button app-button-primary inline-flex items-center gap-2"
                >
                  <CheckCircle2
                    size={17}
                    aria-hidden="true"
                  />
                  Approve order
                </button>
              </div>
            )}
        </div>
      )}
    </section>
  );
}

export function OrderReviewPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canReview = user?.role === USER_ROLES.FACTORY_ADMIN;

  const [orders, setOrders] = useState<
    SalesOrderReviewItem[]
  >([]);

  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [statusFilter, setStatusFilter] =
    useState<ReviewFilter>("submitted");

  const [dateFromInput, setDateFromInput] = useState("");
  const [dateToInput, setDateToInput] = useState("");

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [filterError, setFilterError] =
    useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedOrderId, setSelectedOrderId] =
    useState<UUID | null>(null);

  const [pendingDecision, setPendingDecision] =
    useState<PendingDecision | null>(null);

  const [rejectionReason, setRejectionReason] =
    useState("");

  const [decisionError, setDecisionError] =
    useState<string | null>(null);

  const [decisionLoading, setDecisionLoading] =
    useState(false);

  const [successMessage, setSuccessMessage] =
    useState<string | null>(null);

  const decisionKeyRef = useRef<string | null>(null);
  const decisionInFlightRef = useRef(false);

  const filters = useMemo<ReviewFilters>(
    () => ({
      page,
      search,
      approvalStatus: statusFilter,
      dateFrom,
      dateTo,
    }),
    [page, search, statusFilter, dateFrom, dateTo],
  );

  const loadOrders = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canReview) {
        setOrders([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchReviewOrders(
          filters,
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setOrders(response.items);
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
    [canReview, filters],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadOrders(controller.signal);

    return () => controller.abort();
  }, [loadOrders]);

  const beginDecision = (
    order: Pick<
      SalesOrderReviewItem,
      "id" | "order_number" | "approval_status"
    >,
    action: ReviewAction,
  ): void => {
    if (
      !canReview ||
      !isOnline ||
      decisionLoading ||
      order.approval_status !== "submitted"
    ) {
      return;
    }

    decisionKeyRef.current = null;
    setDecisionError(null);
    setRejectionReason("");

    setPendingDecision({
      orderId: order.id,
      orderNumber: order.order_number,
      action,
    });
  };

  const closeDecision = (): void => {
    if (decisionLoading) {
      return;
    }

    setPendingDecision(null);
    setDecisionError(null);
    setRejectionReason("");
    decisionKeyRef.current = null;
  };

  const submitDecision = async (): Promise<void> => {
    if (
      !pendingDecision ||
      !canReview ||
      !isOnline ||
      decisionInFlightRef.current
    ) {
      return;
    }

    const reason = rejectionReason.trim();

    if (
      pendingDecision.action === "reject" &&
      (!reason || reason.length > MAX_REJECTION_REASON_LENGTH)
    ) {
      setDecisionError(
        `Enter a rejection reason of 1–${MAX_REJECTION_REASON_LENGTH} characters.`,
      );
      return;
    }

    const idempotencyKey =
      decisionKeyRef.current ?? crypto.randomUUID();

    decisionKeyRef.current = idempotencyKey;
    decisionInFlightRef.current = true;

    setDecisionLoading(true);
    setDecisionError(null);
    setSuccessMessage(null);

    try {
      const result =
        pendingDecision.action === "approve"
          ? await approveOrder(
              pendingDecision.orderId,
              idempotencyKey,
            )
          : await rejectOrder(
              pendingDecision.orderId,
              reason,
              idempotencyKey,
            );

      const expectedStatus =
        pendingDecision.action === "approve"
          ? "approved"
          : "rejected";

      if (result.approval_status !== expectedStatus) {
        throw new Error(
          "The backend did not confirm the requested order status. Refresh the order register before taking further action.",
        );
      }

      setSuccessMessage(
        `Order ${pendingDecision.orderNumber} was ${
          pendingDecision.action === "approve"
            ? "approved"
            : "rejected"
        }.`,
      );

      setPendingDecision(null);
      setSelectedOrderId(null);
      setRejectionReason("");
      decisionKeyRef.current = null;

      await loadOrders();
    } catch (failure) {
      setDecisionError(getApiErrorMessage(failure));
    } finally {
      decisionInFlightRef.current = false;
      setDecisionLoading(false);
    }
  };

  const handleFilterSubmit = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();

    if (dateFromInput && !isValidDate(dateFromInput)) {
      setFilterError("Enter a valid start date.");
      return;
    }

    if (dateToInput && !isValidDate(dateToInput)) {
      setFilterError("Enter a valid end date.");
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
    setStatusFilter("submitted");
    setDateFromInput("");
    setDateToInput("");
    setDateFrom("");
    setDateTo("");
    setFilterError(null);
    setPage(1);
  };

  const columns = useMemo<
    DataTableColumn<SalesOrderReviewItem>[]
  >(
    () => [
      {
        key: "order_number",
        header: "Order number",
        render: (row) => (
          <button
            type="button"
            onClick={() => setSelectedOrderId(row.id)}
            className="text-left font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {row.order_number}
          </button>
        ),
      },
      {
        key: "order_date",
        header: "Order date",
        render: (row) => formatDate(row.order_date),
      },
      {
        key: "customer",
        header: "Customer",
        render: (row) => (
          <div>
            <p className="font-medium text-text-primary">
              {row.customer_name}
            </p>

            <p className="mt-1 text-xs text-text-muted">
              {row.salesman_name}
            </p>
          </div>
        ),
      },
      {
        key: "submitted_at",
        header: "Submitted",
        render: (row) =>
          row.submitted_at
            ? formatDateTime(row.submitted_at)
            : "—",
      },
      {
        key: "item_count",
        header: "Items",
        numeric: true,
        render: (row) => (
          <span className="app-numeric">
            {row.item_count}
          </span>
        ),
      },
      {
        key: "total_amount",
        header: "Order total",
        numeric: true,
        render: (row) => (
          <span className="app-numeric">
            {formatCurrency(row.total_amount)}
          </span>
        ),
      },
      {
        key: "approval_status",
        header: "Approval",
        render: (row) => (
          <StatusBadge
            status={row.approval_status}
            category="order"
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
              onClick={() => setSelectedOrderId(row.id)}
              className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
            >
              <Eye size={15} aria-hidden="true" />
              Review
            </button>

            {row.approval_status === "submitted" && (
              <>
                <button
                  type="button"
                  onClick={() => beginDecision(row, "approve")}
                  disabled={!isOnline || decisionLoading}
                  className="text-sm font-medium text-success hover:underline disabled:opacity-50"
                >
                  Approve
                </button>

                <button
                  type="button"
                  onClick={() => beginDecision(row, "reject")}
                  disabled={!isOnline || decisionLoading}
                  className="text-sm font-medium text-error hover:underline disabled:opacity-50"
                >
                  Reject
                </button>
              </>
            )}
          </div>
        ),
      },
    ],
    [isOnline, decisionLoading],
  );

  if (!canReview) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Sales Order Review
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Sales order approval and rejection are restricted
          to the Factory Admin role.
        </div>

        <Link
          to="/sales/orders"
          className="app-button app-button-secondary"
        >
          Back to sales orders
        </Link>
      </div>
    );
  }

  return (
    <div className="app-page space-y-6">
      <header className="space-y-4">
        <Link
          to="/sales/orders"
          className="inline-flex items-center gap-2 text-sm font-medium text-accent hover:underline"
        >
          <ArrowLeft size={17} aria-hidden="true" />
          Sales orders
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <ClipboardCheck
                size={26}
                className="text-primary"
                aria-hidden="true"
              />

              <h2 className="app-page-title">
                Sales Order Review
              </h2>
            </div>

            <p className="app-page-description">
              Review submitted customer orders and record
              authorized approval or rejection decisions.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              void loadOrders();
            }}
            disabled={loading || decisionLoading || !isOnline}
            className="app-button app-button-secondary inline-flex items-center gap-2"
          >
            <RefreshCw
              size={17}
              className={
                loading ? "motion-safe:animate-spin" : ""
              }
              aria-hidden="true"
            />
            Refresh
          </button>
        </div>
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
            A backend connection is required to review,
            approve, or reject official sales orders.
            Approval decisions are not queued offline.
          </p>
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          className="app-alert app-alert-success flex items-start gap-3"
        >
          <CheckCircle2
            size={19}
            className="shrink-0"
            aria-hidden="true"
          />
          {successMessage}
        </div>
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
              Approval workflow
            </h3>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Only submitted orders can be approved or
              rejected. The backend validates order status,
              product and customer eligibility, pricing,
              permissions, and concurrent decisions.
              Approval does not itself create a GST invoice,
              dispatch finished goods, or collect payment.
            </p>
          </div>
        </div>
      </div>

      <section className="app-card space-y-5">
        <div>
          <h3 className="text-base font-semibold text-text-primary">
            Order review queue
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            The default view contains orders awaiting
            Factory Admin review.
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
                htmlFor="review-search"
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
                  id="review-search"
                  type="search"
                  value={searchInput}
                  onChange={(event) =>
                    setSearchInput(event.target.value)
                  }
                  placeholder="Order or customer..."
                  className="app-input w-full pl-10"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="review-status"
                className="app-field-label mb-2 block"
              >
                Approval status
              </label>

              <select
                id="review-status"
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(
                    event.target.value as ReviewFilter,
                  );
                  setPage(1);
                }}
                className="app-select w-full"
              >
                {REVIEW_FILTERS.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="review-date-from"
                className="app-field-label mb-2 block"
              >
                Date from
              </label>

              <input
                id="review-date-from"
                type="date"
                value={dateFromInput}
                onChange={(event) =>
                  setDateFromInput(event.target.value)
                }
                className="app-input w-full"
              />
            </div>

            <div>
              <label
                htmlFor="review-date-to"
                className="app-field-label mb-2 block"
              >
                Date to
              </label>

              <input
                id="review-date-to"
                type="date"
                value={dateToInput}
                onChange={(event) =>
                  setDateToInput(event.target.value)
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

        {loading && orders.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading order review queue..."
          />
        ) : (
          <DataTable<SalesOrderReviewItem>
            columns={columns}
            data={orders}
            getRowId={(row) => row.id}
            loading={loading}
            error={error}
            onRetry={() => loadOrders()}
            emptyMessage="No orders found"
            emptyDescription="No orders match the selected review filters."
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="sales-order-review-table"
          />
        )}
      </section>

      {selectedOrderId && (
        <OrderDetailsPanel
          orderId={selectedOrderId}
          onClose={() => setSelectedOrderId(null)}
          onApprove={(order) =>
            beginDecision(order, "approve")
          }
          onReject={(order) =>
            beginDecision(order, "reject")
          }
          canReview={canReview}
          isOnline={isOnline}
        />
      )}

      <ConfirmDialog
        open={
          pendingDecision !== null &&
          pendingDecision.action === "approve"
        }
        title="Approve sales order"
        message={
          pendingDecision
            ? `Approve order ${pendingDecision.orderNumber}?`
            : ""
        }
        description="The backend will revalidate the submitted order and record the authorized approval. Invoicing and dispatch remain separate operations."
        variant="default"
        confirmLabel="Approve order"
        cancelLabel="Cancel"
        isLoading={decisionLoading}
        onCancel={closeDecision}
        onConfirm={submitDecision}
      >
        {decisionError && (
          <div
            role="alert"
            className="app-alert app-alert-error"
          >
            <p>{decisionError}</p>

            <p className="mt-2 text-xs">
              If the response was interrupted, verify the
              current order status before retrying.
            </p>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={
          pendingDecision !== null &&
          pendingDecision.action === "reject"
        }
        title="Reject sales order"
        message={
          pendingDecision
            ? `Reject order ${pendingDecision.orderNumber}?`
            : ""
        }
        description="A rejection reason is required and will be recorded by the backend."
        variant="danger"
        confirmLabel="Reject order"
        cancelLabel="Cancel"
        isLoading={decisionLoading}
        onCancel={closeDecision}
        onConfirm={submitDecision}
      >
        <div className="space-y-2">
          <label
            htmlFor="review-rejection-reason"
            className="app-field-label block"
          >
            Rejection reason *
          </label>

          <textarea
            id="review-rejection-reason"
            value={rejectionReason}
            onChange={(event) => {
              setRejectionReason(event.target.value);
              setDecisionError(null);
              decisionKeyRef.current = null;
            }}
            maxLength={MAX_REJECTION_REASON_LENGTH}
            rows={4}
            required
            disabled={decisionLoading}
            className="app-textarea w-full"
            placeholder="Explain why the order cannot be approved."
          />

          <p className="app-field-help">
            {rejectionReason.length}/
            {MAX_REJECTION_REASON_LENGTH} characters
          </p>
        </div>

        {decisionError && (
          <div
            role="alert"
            className="app-alert app-alert-error"
          >
            <p>{decisionError}</p>

            <p className="mt-2 text-xs">
              If the response was interrupted, verify the
              current order status before retrying.
            </p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

export default OrderReviewPage;