import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  FileCheck2,
  FileText,
  Printer,
  RefreshCw,
  Share2,
  WifiOff,
} from "lucide-react";

import {
  Link,
  useParams,
} from "react-router-dom";

import { USER_ROLES } from "../../types/auth";

import type {
  Address,
  GSTInvoice,
  InvoiceItem,
  UUID,
} from "../../types/business";

import { useAuth } from "../../hooks/useAuth";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";

import {
  apiClient,
  getApiErrorMessage,
} from "../../services/api/client";

import { LoadingState } from "../../components/common/LoadingState";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { StatusBadge } from "../../components/common/StatusBadge";

import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatQuantity,
} from "../../utils/formatters";

interface InvoiceDetails extends GSTInvoice {
  customer_name?: string;
  customer_gstin?: string | null;
  sales_order_number?: string | null;
  company_name?: string | null;
  company_gstin?: string | null;
  company_address?: Address | null;
  posted_at?: string | null;
  notes?: string | null;
}

interface InvoiceLineDetails extends InvoiceItem {
  product_code?: string;
  product_name?: string;
  hsn_code?: string | null;
}

function formatAddress(address: Address | null | undefined): string[] {
  if (!address) {
    return [];
  }

  return [
    address.line1,
    address.line2,
    [address.city, address.state].filter(Boolean).join(", "),
    [address.postal_code, address.country]
      .filter(Boolean)
      .join(", "),
  ].filter((part): part is string => Boolean(part?.trim()));
}

function formatSupplyType(value: string): string {
  if (value === "intrastate") {
    return "Intrastate (CGST + SGST)";
  }

  if (value === "interstate") {
    return "Interstate (IGST)";
  }

  return value;
}

function invoiceText(invoice: InvoiceDetails): string {
  const lines: string[] = [
    invoice.company_name ?? "GST Tax Invoice",
    "GST TAX INVOICE",
    `Invoice: ${invoice.invoice_number}`,
    `Financial year: ${invoice.financial_year}`,
    `Invoice date: ${formatDate(invoice.invoice_date)}`,
    `Status: ${invoice.status}`,
    `Customer: ${invoice.customer_name ?? invoice.customer_id}`,
  ];

  if (invoice.company_gstin) {
    lines.push(`Supplier GSTIN: ${invoice.company_gstin}`);
  }

  if (invoice.customer_gstin) {
    lines.push(`Customer GSTIN: ${invoice.customer_gstin}`);
  }

  if (invoice.sales_order_number) {
    lines.push(`Sales order: ${invoice.sales_order_number}`);
  }

  lines.push(
    `Supply type: ${formatSupplyType(invoice.supply_type)}`,
    "",
    "Billing address:",
    ...formatAddress(invoice.billing_address),
    "",
    "Shipping address:",
    ...formatAddress(invoice.shipping_address),
    "",
    "Items:",
  );

  for (const item of invoice.items as InvoiceLineDetails[]) {
    lines.push(
      `${item.product_name ?? item.product_id}`,
      `Quantity: ${formatQuantity(item.quantity)} ${item.unit}`,
      `Unit price: ${formatCurrency(item.unit_price)}`,
      `Taxable amount: ${formatCurrency(item.taxable_amount)}`,
      `GST rate: ${item.gst_rate}%`,
      `CGST: ${formatCurrency(item.cgst_amount)}`,
      `SGST: ${formatCurrency(item.sgst_amount)}`,
      `IGST: ${formatCurrency(item.igst_amount)}`,
      `Line total: ${formatCurrency(item.line_total)}`,
      "",
    );
  }

  lines.push(
    `Taxable amount: ${formatCurrency(invoice.tax_summary.taxable_amount)}`,
    `CGST: ${formatCurrency(invoice.tax_summary.cgst_amount)}`,
    `SGST: ${formatCurrency(invoice.tax_summary.sgst_amount)}`,
    `IGST: ${formatCurrency(invoice.tax_summary.igst_amount)}`,
    `Total GST: ${formatCurrency(invoice.tax_summary.total_tax)}`,
    `Invoice total: ${formatCurrency(invoice.tax_summary.total_amount)}`,
    `Amount paid: ${formatCurrency(invoice.amount_paid)}`,
    `Outstanding: ${formatCurrency(invoice.outstanding_amount)}`,
    `Payment status: ${invoice.payment_status}`,
  );

  return lines.join("\n");
}

async function fetchInvoice(
  invoiceId: UUID,
  signal?: AbortSignal,
): Promise<InvoiceDetails> {
  return apiClient.get<InvoiceDetails>(
    `/invoices/${encodeURIComponent(invoiceId)}`,
    { signal },
  );
}

async function postInvoice(
  invoiceId: UUID,
  idempotencyKey: string,
): Promise<InvoiceDetails> {
  return apiClient.post<InvoiceDetails>(
    `/invoices/${encodeURIComponent(invoiceId)}/post`,
    {},
    { idempotencyKey },
  );
}

function AddressSection({
  title,
  address,
}: {
  title: string;
  address: Address | null | undefined;
}) {
  const lines = formatAddress(address);

  return (
    <section className="rounded-control border border-border p-4">
      <h3 className="text-sm font-semibold text-text-primary">
        {title}
      </h3>

      {lines.length > 0 ? (
        <address className="mt-3 space-y-1 text-sm not-italic text-text-muted">
          {lines.map((line, index) => (
            <p key={`${index}-${line}`}>
              {line}
            </p>
          ))}
        </address>
      ) : (
        <p className="mt-3 text-sm text-text-muted">
          Address unavailable
        </p>
      )}
    </section>
  );
}

function AmountRow({
  label,
  amount,
  emphasized = false,
}: {
  label: string;
  amount: string;
  emphasized?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 ${
        emphasized
          ? "border-t border-border pt-3"
          : ""
      }`}
    >
      <dt
        className={
          emphasized
            ? "font-semibold text-text-primary"
            : "text-text-muted"
        }
      >
        {label}
      </dt>

      <dd
        className={`app-numeric whitespace-nowrap ${
          emphasized
            ? "text-base font-bold text-text-primary"
            : "font-medium text-text-primary"
        }`}
      >
        {formatCurrency(amount)}
      </dd>
    </div>
  );
}

export function InvoiceDetailsPage() {
  const { id } = useParams<{ id: string }>();

  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canAccess =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.ACCOUNTANT_AUDITOR ||
    user?.role === USER_ROLES.OWNER;

  const canManage =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [invoice, setInvoice] =
    useState<InvoiceDetails | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [success, setSuccess] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  const [postOpen, setPostOpen] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] =
    useState<string | null>(null);

  const postKeyRef = useRef<string | null>(null);
  const postingLockRef = useRef(false);

  const loadInvoice = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canAccess || !id) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetchInvoice(
          id,
          signal,
        );

        if (!signal?.aborted) {
          setInvoice(response);
        }
      } catch (failure) {
        if (!signal?.aborted) {
          setError(getApiErrorMessage(failure));
          setInvoice(null);
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [canAccess, id],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadInvoice(controller.signal);

    return () => controller.abort();
  }, [loadInvoice]);

  const openPost = (): void => {
    if (
      !invoice ||
      !canManage ||
      !isOnline ||
      invoice.status !== "draft" ||
      posting
    ) {
      return;
    }

    setPostError(null);
    setSuccess(null);
    postKeyRef.current = null;
    setPostOpen(true);
  };

  const closePost = (): void => {
    if (posting) {
      return;
    }

    setPostOpen(false);
    setPostError(null);
    postKeyRef.current = null;
  };

  const submitPost = async (): Promise<void> => {
    if (
      !invoice ||
      !canManage ||
      !isOnline ||
      invoice.status !== "draft" ||
      postingLockRef.current
    ) {
      return;
    }

    const idempotencyKey =
      postKeyRef.current ??
      crypto.randomUUID();

    postKeyRef.current = idempotencyKey;
    postingLockRef.current = true;

    setPosting(true);
    setPostError(null);
    setSuccess(null);

    try {
      const result = await postInvoice(
        invoice.id,
        idempotencyKey,
      );

      if (
        result.id !== invoice.id ||
        result.status !== "posted"
      ) {
        throw new Error(
          "The backend did not confirm invoice posting. Refresh the invoice before retrying.",
        );
      }

      setInvoice(result);
      setPostOpen(false);
      postKeyRef.current = null;

      setSuccess(
        `Invoice ${result.invoice_number} was posted successfully.`,
      );
    } catch (failure) {
      setPostError(getApiErrorMessage(failure));
    } finally {
      postingLockRef.current = false;
      setPosting(false);
    }
  };

  const handlePrint = (): void => {
    if (!invoice) {
      return;
    }

    window.print();
  };

  const handleShare = async (): Promise<void> => {
    if (!invoice) {
      return;
    }

    setShareError(null);
    setSuccess(null);

    const text = invoiceText(invoice);

    try {
      if (navigator.share) {
        await navigator.share({
          title: `Invoice ${invoice.invoice_number}`,
          text,
        });

        return;
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);

        setSuccess(
          "Invoice details copied to the clipboard.",
        );

        return;
      }

      throw new Error(
        "Sharing and clipboard access are unavailable in this browser.",
      );
    } catch (failure) {
      if (
        failure instanceof DOMException &&
        failure.name === "AbortError"
      ) {
        return;
      }

      setShareError(
        failure instanceof Error
          ? failure.message
          : "Invoice sharing failed.",
      );
    }
  };

  if (!canAccess) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Invoice Details
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Invoice details are restricted to authorized
          Factory Admin, Accountant/Auditor, and
          Owner roles.
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

  if (!id) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">
          Invoice Details
        </h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          An invoice identifier is required.
        </div>

        <Link
          to="/invoices"
          className="app-button app-button-secondary"
        >
          Back to invoices
        </Link>
      </div>
    );
  }

  return (
    <div className="app-page space-y-6">
      <header className="app-no-print space-y-4">
        <Link
          to="/invoices"
          className="inline-flex items-center gap-2 text-sm font-medium text-accent hover:underline"
        >
          <ArrowLeft
            size={17}
            aria-hidden="true"
          />
          Invoice register
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <FileText
                size={27}
                className="text-primary"
                aria-hidden="true"
              />

              <h2 className="app-page-title">
                Invoice Details
              </h2>
            </div>

            <p className="app-page-description">
              Review the backend-recorded GST invoice,
              tax breakdown, and payment status.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void loadInvoice();
              }}
              disabled={loading || posting}
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

            {invoice && (
              <>
                <button
                  type="button"
                  onClick={handlePrint}
                  className="app-button app-button-secondary inline-flex items-center gap-2"
                >
                  <Printer
                    size={17}
                    aria-hidden="true"
                  />
                  Print
                </button>

                <button
                  type="button"
                  onClick={() => {
                    void handleShare();
                  }}
                  className="app-button app-button-secondary inline-flex items-center gap-2"
                >
                  <Share2
                    size={17}
                    aria-hidden="true"
                  />
                  Share
                </button>

                {canManage &&
                  invoice.status === "draft" && (
                    <button
                      type="button"
                      onClick={openPost}
                      disabled={!isOnline || posting}
                      className="app-button app-button-primary inline-flex items-center gap-2"
                    >
                      <FileCheck2
                        size={17}
                        aria-hidden="true"
                      />
                      Post invoice
                    </button>
                  )}
              </>
            )}
          </div>
        </div>
      </header>

      {!isOnline && (
        <div
          role="status"
          className="app-alert app-alert-warning app-no-print flex items-start gap-3"
        >
          <WifiOff
            size={20}
            className="shrink-0"
            aria-hidden="true"
          />

          <p>
            The device is offline. Invoice details
            require a backend connection. Posting
            cannot be performed offline.
          </p>
        </div>
      )}

      {success && (
        <div
          role="status"
          className="app-alert app-alert-success app-no-print flex items-start gap-3"
        >
          <CheckCircle2
            size={19}
            className="shrink-0"
            aria-hidden="true"
          />

          <p>{success}</p>
        </div>
      )}

      {shareError && (
        <div
          role="alert"
          className="app-alert app-alert-error app-no-print"
        >
          {shareError}
        </div>
      )}

      {loading && (
        <LoadingState
          variant="page"
          message="Loading invoice details..."
        />
      )}

      {!loading && error && (
        <div
          role="alert"
          className="app-alert app-alert-error app-no-print space-y-3"
        >
          <p>{error}</p>

          <button
            type="button"
            onClick={() => {
              void loadInvoice();
            }}
            className="app-button app-button-secondary"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && invoice && (
        <article
          aria-labelledby="invoice-document-title"
          className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-8 print:border-0 print:p-0 print:shadow-none"
        >
          <div className="space-y-8">
            <div className="flex flex-col gap-5 border-b border-border pb-6 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-text-muted">
                  GST Tax Invoice
                </p>

                <h1
                  id="invoice-document-title"
                  className="mt-2 break-all text-2xl font-bold text-text-primary"
                >
                  {invoice.invoice_number}
                </h1>

                <p className="mt-2 text-sm text-text-muted">
                  Financial year:{" "}
                  {invoice.financial_year}
                </p>

                {invoice.company_name && (
                  <p className="mt-3 font-semibold text-text-primary">
                    {invoice.company_name}
                  </p>
                )}

                {invoice.company_gstin && (
                  <p className="mt-1 text-sm text-text-muted">
                    Supplier GSTIN:{" "}
                    {invoice.company_gstin}
                  </p>
                )}

                {invoice.company_address && (
                  <address className="mt-2 space-y-1 text-sm not-italic text-text-muted">
                    {formatAddress(
                      invoice.company_address,
                    ).map((line, index) => (
                      <p key={`${index}-${line}`}>
                        {line}
                      </p>
                    ))}
                  </address>
                )}
              </div>

              <div className="space-y-3 sm:text-right">
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  <StatusBadge
                    status={invoice.status}
                    category="transaction"
                    showDot
                  />

                  <StatusBadge
                    status={invoice.payment_status}
                    category="payment"
                    showDot
                  />
                </div>

                <p className="text-sm text-text-muted">
                  Invoice date:{" "}
                  <span className="font-medium text-text-primary">
                    {formatDate(
                      invoice.invoice_date,
                    )}
                  </span>
                </p>

                {invoice.posted_at && (
                  <p className="text-sm text-text-muted">
                    Posted:{" "}
                    {formatDateTime(
                      invoice.posted_at,
                    )}
                  </p>
                )}

                {invoice.sales_order_number && (
                  <p className="text-sm text-text-muted">
                    Sales order:{" "}
                    {invoice.sales_order_number}
                  </p>
                )}
              </div>
            </div>

            {invoice.status !== "posted" && (
              <div className="rounded-control border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
                {invoice.status === "draft"
                  ? "Draft invoice — not yet posted."
                  : "Cancelled invoice — not valid for active transaction processing."}
              </div>
            )}

            <div className="grid gap-5 lg:grid-cols-3">
              <div className="space-y-4 lg:col-span-1">
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">
                    Customer
                  </h3>

                  <p className="mt-2 text-sm font-medium text-text-primary">
                    {invoice.customer_name ??
                      invoice.customer_id}
                  </p>

                  {invoice.customer_gstin && (
                    <p className="mt-1 text-sm text-text-muted">
                      GSTIN:{" "}
                      {invoice.customer_gstin}
                    </p>
                  )}
                </div>

                <div>
                  <h3 className="text-sm font-semibold text-text-primary">
                    Supply classification
                  </h3>

                  <p className="mt-2 text-sm text-text-muted">
                    {formatSupplyType(
                      invoice.supply_type,
                    )}
                  </p>
                </div>
              </div>

              <AddressSection
                title="Billing address"
                address={invoice.billing_address}
              />

              <AddressSection
                title="Shipping address"
                address={invoice.shipping_address}
              />
            </div>

            <section aria-labelledby="invoice-items-title">
              <h3
                id="invoice-items-title"
                className="mb-4 text-base font-semibold text-text-primary"
              >
                Invoice items
              </h3>

              <div className="app-table-container overflow-x-auto">
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
                        Taxable
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
                        CGST
                      </th>
                      <th
                        scope="col"
                        className="text-right"
                      >
                        SGST
                      </th>
                      <th
                        scope="col"
                        className="text-right"
                      >
                        IGST
                      </th>
                      <th
                        scope="col"
                        className="text-right"
                      >
                        Total
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {(
                      invoice.items as InvoiceLineDetails[]
                    ).map((item) => (
                      <tr key={item.id}>
                        <td>
                          <p className="font-medium text-text-primary">
                            {item.product_name ??
                              item.product_id}
                          </p>

                          {item.product_code && (
                            <p className="mt-1 text-xs text-text-muted">
                              {item.product_code}
                            </p>
                          )}

                          {item.hsn_code && (
                            <p className="mt-1 text-xs text-text-muted">
                              HSN: {item.hsn_code}
                            </p>
                          )}
                        </td>

                        <td className="app-numeric whitespace-nowrap text-right">
                          {formatQuantity(
                            item.quantity,
                          )}{" "}
                          {item.unit}
                        </td>

                        <td className="app-numeric whitespace-nowrap text-right">
                          {formatCurrency(
                            item.unit_price,
                          )}
                        </td>

                        <td className="app-numeric whitespace-nowrap text-right">
                          {formatCurrency(
                            item.taxable_amount,
                          )}
                        </td>

                        <td className="app-numeric whitespace-nowrap text-right">
                          {item.gst_rate}%
                        </td>

                        <td className="app-numeric whitespace-nowrap text-right">
                          {formatCurrency(
                            item.cgst_amount,
                          )}
                        </td>

                        <td className="app-numeric whitespace-nowrap text-right">
                          {formatCurrency(
                            item.sgst_amount,
                          )}
                        </td>

                        <td className="app-numeric whitespace-nowrap text-right">
                          {formatCurrency(
                            item.igst_amount,
                          )}
                        </td>

                        <td className="app-numeric whitespace-nowrap text-right font-semibold">
                          {formatCurrency(
                            item.line_total,
                          )}
                        </td>
                      </tr>
                    ))}

                    {invoice.items.length === 0 && (
                      <tr>
                        <td
                          colSpan={9}
                          className="py-8 text-center text-text-muted"
                        >
                          No invoice items were returned.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-4">
                {invoice.notes && (
                  <section>
                    <h3 className="text-sm font-semibold text-text-primary">
                      Notes
                    </h3>

                    <p className="mt-2 whitespace-pre-wrap text-sm text-text-muted">
                      {invoice.notes}
                    </p>
                  </section>
                )}

                <div className="rounded-control border border-border bg-background p-4 text-xs leading-5 text-text-muted">
                  Tax amounts, invoice totals, and payment
                  balances are supplied by the backend.
                  Dispatch and payment collection are
                  recorded through separate workflows.
                </div>
              </div>

              <section
                aria-labelledby="invoice-totals-title"
                className="rounded-control border border-border p-5"
              >
                <h3
                  id="invoice-totals-title"
                  className="mb-5 text-base font-semibold text-text-primary"
                >
                  Tax and payment summary
                </h3>

                <dl className="space-y-3 text-sm">
                  <AmountRow
                    label="Taxable amount"
                    amount={
                      invoice.tax_summary
                        .taxable_amount
                    }
                  />

                  <AmountRow
                    label="CGST"
                    amount={
                      invoice.tax_summary
                        .cgst_amount
                    }
                  />

                  <AmountRow
                    label="SGST"
                    amount={
                      invoice.tax_summary
                        .sgst_amount
                    }
                  />

                  <AmountRow
                    label="IGST"
                    amount={
                      invoice.tax_summary
                        .igst_amount
                    }
                  />

                  <AmountRow
                    label="Total GST"
                    amount={
                      invoice.tax_summary
                        .total_tax
                    }
                  />

                  <AmountRow
                    label="Invoice total"
                    amount={
                      invoice.tax_summary
                        .total_amount
                    }
                    emphasized
                  />

                  <AmountRow
                    label="Amount paid"
                    amount={invoice.amount_paid}
                  />

                  <AmountRow
                    label="Outstanding"
                    amount={
                      invoice.outstanding_amount
                    }
                    emphasized
                  />
                </dl>
              </section>
            </div>

            <footer className="border-t border-border pt-5 text-xs text-text-muted">
              Invoice reference:{" "}
              {invoice.invoice_number}
            </footer>
          </div>
        </article>
      )}

      <ConfirmDialog
        open={postOpen}
        title="Post GST invoice"
        message={
          invoice
            ? `Post invoice ${invoice.invoice_number}?`
            : ""
        }
        description="Posting finalizes the invoice through the backend. Confirm that customer details, invoice lines, and GST totals have been reviewed. Posting does not dispatch stock or record payment."
        variant="warning"
        confirmLabel="Post invoice"
        cancelLabel="Cancel"
        isLoading={posting}
        onCancel={closePost}
        onConfirm={submitPost}
      >
        {invoice && (
          <div className="space-y-3 rounded-control border border-border p-4 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-text-muted">
                Invoice
              </span>

              <span className="font-medium">
                {invoice.invoice_number}
              </span>
            </div>

            <div className="flex justify-between gap-4">
              <span className="text-text-muted">
                Total
              </span>

              <span className="app-numeric font-semibold">
                {formatCurrency(
                  invoice.tax_summary.total_amount,
                )}
              </span>
            </div>
          </div>
        )}

        {postError && (
          <div
            role="alert"
            className="app-alert app-alert-error"
          >
            <div className="flex items-start gap-2">
              <AlertCircle
                size={18}
                className="shrink-0"
                aria-hidden="true"
              />

              <div>
                <p>{postError}</p>

                <p className="mt-2 text-xs">
                  If the response was interrupted,
                  verify the current invoice status
                  before retrying.
                </p>
              </div>
            </div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

export default InvoiceDetailsPage;