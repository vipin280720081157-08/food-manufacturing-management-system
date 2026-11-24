import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import {
  ArrowRight,
  ClipboardList,
  Eye,
  Plus,
  RefreshCw,
  Search,
  WifiOff,
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

import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatQuantity,
} from "../../utils/formatters";

const PAGE_SIZE = 20;

type OrderStatusFilter = "all" | OrderApprovalStatus;

interface SalesOrderListItem {
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

interface SalesOrderItemDetails {
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

interface SalesOrderDetails extends SalesOrderListItem {
  items: SalesOrderItemDetails[];
}

interface SalesOrderFilters {
  page: number;
  search: string;
  approvalStatus: string;
  dateFrom: string;
  dateTo: string;
}

const APPROVAL_STATUS_OPTIONS: ReadonlyArray<{
  value: OrderStatusFilter;
  label: string;
}> = [
  { value: "all", label: "All approval statuses" },
  { value: "draft", label: "Draft" },
  { value: "submitted", label: "Submitted" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
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

async function fetchSalesOrders(
  filters: SalesOrderFilters,
  signal?: AbortSignal,
): Promise<PaginatedResponse<SalesOrderListItem>> {
  return apiClient.get<
    PaginatedResponse<SalesOrderListItem>
  >("/sales/orders", {
    query: {
      page: filters.page,
      page_size: PAGE_SIZE,
      search: filters.search || undefined,
      approval_status: filters.approvalStatus || undefined,
      date_from: filters.dateFrom || undefined,
      date_to: filters.dateTo || undefined,
    },
    signal,
  });
}

async function fetchSalesOrderDetails(
  orderId: UUID,
  signal?: AbortSignal,
): Promise<SalesOrderDetails> {
  return apiClient.get<SalesOrderDetails>(
    `/sales/orders/${encodeURIComponent(orderId)}`,
    { signal },
  );
}

function OrderDetailsDialog({
  orderId,
  onClose,
}: {
  orderId: UUID;
  onClose: () => void;
}) {
  const [order, setOrder] =
    useState<SalesOrderDetails | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOrder = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetchSalesOrderDetails(
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

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleEscape);

    return () =>
      document.removeEventListener(
        "keydown",
        handleEscape,
      );
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="sales-order-details-title"
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div>
            <h3
              id="sales-order-details-title"
              className="text-lg font-semibold text-text-primary"
            >
              {order?.order_number ?? "Sales order details"}
            </h3>

            <p className="mt-1 text-sm text-text-muted">
              Backend-recorded order information
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="app-button app-button-secondary"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
          {loading && (
            <LoadingState
              variant="section"
              message="Loading sales order..."
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
                className="mt-3 text-sm font-medium underline"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && order && (
            <>
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
                    "Submitted at",
                    order.submitted_at
                      ? formatDateTime(order.submitted_at)
                      : "—",
                  ],
                  [
                    "Approved at",
                    order.approved_at
                      ? formatDateTime(order.approved_at)
                      : "—",
                  ],
                  [
                    "Created at",
                    formatDateTime(order.created_at),
                  ],
                  [
                    "Last updated",
                    order.updated_at
                      ? formatDateTime(order.updated_at)
                      : "—",
                  ],
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

              {order.rejection_reason && (
                <div className="app-alert app-alert-warning">
                  <p className="font-semibold">
                    Rejection reason
                  </p>

                  <p className="mt-1 whitespace-pre-wrap">
                    {order.rejection_reason}
                  </p>
                </div>
              )}

              {order.notes && (
                <div>
                  <h4 className="text-sm font-semibold text-text-primary">
                    Order notes
                  </h4>

                  <p className="mt-2 whitespace-pre-wrap rounded-control bg-background p-4 text-sm text-text-muted">
                    {order.notes}
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
                          Unit price
                        </th>
                        <th
                          scope="col"
                          className="text-right"
                        >
                          GST rate
                        </th>
                        <th
                          scope="col"
                          className="text-right"
                        >
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

                            <p className="text-xs text-text-muted">
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
                            colSpan={5}
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

              <div className="ml-auto max-w-sm space-y-3 rounded-control border border-border p-4">
                {[
                  ["Taxable amount", order.taxable_amount],
                  ["GST amount", order.total_tax],
                  ["Order total", order.total_amount],
                ].map(([label, amount]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="text-sm text-text-muted">
                      {label}
                    </span>

                    <span className="app-numeric text-sm font-semibold text-text-primary">
                      {formatCurrency(amount)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

export function SalesOrdersPage() {
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canView = user !== null;

  const canCreate =
    user?.role === USER_ROLES.SALESMAN ||
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const canReview =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [orders, setOrders] = useState<
    SalesOrderListItem[]
  >([]);

  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [searchInput, setSearchInput] =
    useState("");
  const [search, setSearch] = useState("");

  const [approvalStatus, setApprovalStatus] =
    useState<OrderStatusFilter>("all");

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

  const [selectedOrderId, setSelectedOrderId] =
    useState<UUID | null>(null);

  const filters = useMemo<SalesOrderFilters>(
    () => ({
      page,
      search,
      approvalStatus:
        approvalStatus === "all"
          ? ""
          : approvalStatus,
      dateFrom,
      dateTo,
    }),
    [
      page,
      search,
      approvalStatus,
      dateFrom,
      dateTo,
    ],
  );

  const loadOrders = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canView) {
        setOrders([]);
        setTotal(0);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchSalesOrders(
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
    [canView, filters],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadOrders(controller.signal);

    return () => controller.abort();
  }, [loadOrders]);

  const handleFilterSubmit = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();

    if (
      dateFromInput &&
      !isValidDate(dateFromInput)
    ) {
      setFilterError("Enter a valid start date.");
      return;
    }

    if (
      dateToInput &&
      !isValidDate(dateToInput)
    ) {
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
    setApprovalStatus("all");
    setDateFromInput("");
    setDateToInput("");
    setDateFrom("");
    setDateTo("");
    setFilterError(null);
    setPage(1);
  };

  const columns = useMemo<
    DataTableColumn<SalesOrderListItem>[]
  >(
    () => [
      {
        key: "order_number",
        header: "Order number",
        render: (row) => (
          <button
            type="button"
            onClick={() =>
              setSelectedOrderId(row.id)
            }
            className="text-left font-semibold text-accent underline-offset-2 hover:underline"
          >
            {row.order_number}
          </button>
        ),
      },
      {
        key: "order_date",
        header: "Order date",
        render: (row) =>
          formatDate(row.order_date),
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
        key: "items",
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
        key: "fulfillment_status",
        header: "Fulfillment",
        render: (row) => (
          <StatusBadge
            status={row.fulfillment_status}
            category="fulfillment"
            showDot
          />
        ),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (row) => (
          <button
            type="button"
            onClick={() =>
              setSelectedOrderId(row.id)
            }
            className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
          >
            <Eye
              size={15}
              aria-hidden="true"
            />
            Details
          </button>
        ),
      },
    ],
    [],
  );

  if (!canView) {
    return (
      <div className="app-page">
        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Authentication is required to view
          sales orders.
        </div>
      </div>
    );
  }

  return (
    <div className="app-page space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <ClipboardList
              size={26}
              className="text-primary"
              aria-hidden="true"
            />

            <h2 className="app-page-title">
              Sales Orders
            </h2>
          </div>

          <p className="app-page-description">
            View customer orders, approval
            status, and fulfillment progress.
            Official records are maintained
            by the backend.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void loadOrders();
            }}
            disabled={loading || !isOnline}
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

          {canCreate && (
            <Link
              to="/sales/orders/new"
              className="app-button app-button-primary inline-flex items-center gap-2"
            >
              <Plus
                size={17}
                aria-hidden="true"
              />
              Create order
            </Link>
          )}
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

          <div>
            <p className="font-medium">
              Backend connection unavailable
            </p>

            <p className="mt-1 text-sm">
              Official sales orders cannot be
              refreshed while offline.
              Salesmen can capture local orders
              through the offline order workflow.
              Unsynchronized drafts are not
              official backend orders.
            </p>

            {user?.role === USER_ROLES.SALESMAN && (
              <Link
                to="/offline/orders"
                className="mt-2 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
              >
                View offline orders
                <ArrowRight
                  size={15}
                  aria-hidden="true"
                />
              </Link>
            )}
          </div>
        </div>
      )}

      {canReview && (
        <div className="rounded-card border border-border bg-surface p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">
                Sales order review
              </h3>

              <p className="mt-1 text-xs text-text-muted">
                Submitted orders require
                authorized Factory Admin review
                before approval and subsequent
                invoicing or dispatch workflows.
              </p>
            </div>

            <Link
              to="/sales/orders/review"
              className="app-button app-button-secondary inline-flex shrink-0 items-center gap-2"
            >
              Review orders
              <ArrowRight
                size={16}
                aria-hidden="true"
              />
            </Link>
          </div>
        </div>
      )}

      <section className="app-card space-y-5">
        <div>
          <h3 className="text-base font-semibold text-text-primary">
            Order register
          </h3>

          <p className="mt-1 text-sm text-text-muted">
            Search and filter backend sales
            orders. Access to individual
            records is enforced by the backend.
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
                htmlFor="sales-order-search"
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
                  id="sales-order-search"
                  type="search"
                  value={searchInput}
                  onChange={(event) =>
                    setSearchInput(
                      event.target.value,
                    )
                  }
                  placeholder="Order or customer..."
                  className="app-input w-full pl-10"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="sales-order-status"
                className="app-field-label mb-2 block"
              >
                Approval status
              </label>

              <select
                id="sales-order-status"
                value={approvalStatus}
                onChange={(event) => {
                  setApprovalStatus(
                    event.target
                      .value as OrderStatusFilter,
                  );
                  setPage(1);
                }}
                className="app-select w-full"
              >
                {APPROVAL_STATUS_OPTIONS.map(
                  (option) => (
                    <option
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </option>
                  ),
                )}
              </select>
            </div>

            <div>
              <label
                htmlFor="sales-order-date-from"
                className="app-field-label mb-2 block"
              >
                Date from
              </label>

              <input
                id="sales-order-date-from"
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
                htmlFor="sales-order-date-to"
                className="app-field-label mb-2 block"
              >
                Date to
              </label>

              <input
                id="sales-order-date-to"
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

        {loading && orders.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading sales orders..."
          />
        ) : (
          <DataTable<SalesOrderListItem>
            columns={columns}
            data={orders}
            getRowId={(row) => row.id}
            loading={loading}
            error={error}
            onRetry={() => loadOrders()}
            emptyMessage="No sales orders found"
            emptyDescription="No official sales orders match the selected filters."
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="sales-orders-table"
          />
        )}
      </section>

      {selectedOrderId && (
        <OrderDetailsDialog
          orderId={selectedOrderId}
          onClose={() =>
            setSelectedOrderId(null)
          }
        />
      )}
    </div>
  );
}

export default SalesOrdersPage;