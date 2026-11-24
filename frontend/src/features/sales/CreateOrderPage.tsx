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
  ClipboardList,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  WifiOff,
} from "lucide-react";

import { Link, useNavigate } from "react-router-dom";

import type {
  Customer,
  Product,
  SalesOrderInput,
  UnitOfMeasure,
  UUID,
} from "../../types/business";

import { USER_ROLES } from "../../types/auth";
import { useAuth } from "../../hooks/useAuth";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";

import {
  apiClient,
  getApiErrorMessage,
} from "../../services/api/client";

import { getCustomers, getProducts } from "../../services/api/mastersApi";

import { LoadingState } from "../../components/common/LoadingState";

import {
  formatCurrency,
  formatQuantity,
} from "../../utils/formatters";

const MAX_NOTES_LENGTH = 2000;
const MAX_ORDER_ITEMS = 100;
const MASTER_PAGE_SIZE = 100;

interface OrderLine {
  clientId: string;
  productId: string;
  quantity: string;
  unitPrice: string;
}

interface OrderFormState {
  customerId: string;
  notes: string;
  lines: OrderLine[];
}

interface CreatedSalesOrder {
  id: UUID;
  order_number: string;
}

interface MasterPage<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

function newOrderLine(): OrderLine {
  return {
    clientId: crypto.randomUUID(),
    productId: "",
    quantity: "",
    unitPrice: "",
  };
}

function createInitialForm(): OrderFormState {
  return {
    customerId: "",
    notes: "",
    lines: [newOrderLine()],
  };
}

function isNonNegativeDecimal(value: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(value.trim());
}

function isPositiveDecimal(value: string): boolean {
  const trimmed = value.trim();

  return (
    isNonNegativeDecimal(trimmed) &&
    /[1-9]/.test(trimmed.replace(".", ""))
  );
}

function hasAtMostDecimalPlaces(
  value: string,
  places: number,
): boolean {
  const fraction = value.trim().split(".")[1];

  return (fraction?.length ?? 0) <= places;
}

function getProductLabel(product: Product): string {
  return `${product.item_code} — ${product.name}`;
}

async function loadAllMasterRecords<T>(
  fetchPage: (
    page: number,
    pageSize: number,
    signal: AbortSignal,
  ) => Promise<MasterPage<T>>,
  signal: AbortSignal,
): Promise<T[]> {
  const records: T[] = [];
  let page = 1;

  while (!signal.aborted) {
    const response = await fetchPage(
      page,
      MASTER_PAGE_SIZE,
      signal,
    );

    records.push(...response.items);

    if (
      response.items.length === 0 ||
      page * MASTER_PAGE_SIZE >= response.total
    ) {
      break;
    }

    page += 1;
  }

  return records;
}

async function fetchActiveCustomers(
  signal: AbortSignal,
): Promise<Customer[]> {
  const customers = await loadAllMasterRecords(
    (page, pageSize, requestSignal) =>
      getCustomers({
        page,
        page_size: pageSize,
      }, { signal: requestSignal }),
    signal,
  );

  return customers.filter((customer) => customer.is_active);
}

async function fetchActiveProducts(
  signal: AbortSignal,
): Promise<Product[]> {
  const products = await loadAllMasterRecords(
    (page, pageSize, requestSignal) =>
      getProducts({
        page,
        page_size: pageSize,
      }, { signal: requestSignal }),
    signal,
  );

  return products.filter((product) => product.is_active);
}

async function createSalesOrder(
  payload: SalesOrderInput,
  idempotencyKey: string,
): Promise<CreatedSalesOrder> {
  return apiClient.post<CreatedSalesOrder>(
    "/sales/orders",
    payload,
    { idempotencyKey },
  );
}

export function CreateOrderPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isOnline } = useOnlineStatus();

  const canCreate =
    user?.role === USER_ROLES.SALESMAN ||
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [form, setForm] = useState<OrderFormState>(
    createInitialForm,
  );

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  const [mastersLoading, setMastersLoading] = useState(true);
  const [mastersError, setMastersError] = useState<string | null>(
    null,
  );

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<
    string | null
  >(null);

  const submissionKeyRef = useRef<string | null>(null);
  const submittedRef = useRef(false);

  const selectedCustomer = useMemo(
    () =>
      customers.find(
        (customer) => customer.id === form.customerId,
      ),
    [customers, form.customerId],
  );

  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products],
  );

  const loadMasters = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!canCreate || !isOnline) {
        setMastersLoading(false);
        return;
      }

      const controller = signal
        ? null
        : new AbortController();

      const requestSignal = signal ?? controller!.signal;

      setMastersLoading(true);
      setMastersError(null);

      try {
        const [customerRecords, productRecords] =
          await Promise.all([
            fetchActiveCustomers(requestSignal),
            fetchActiveProducts(requestSignal),
          ]);

        if (requestSignal.aborted) {
          return;
        }

        setCustomers(customerRecords);
        setProducts(productRecords);
      } catch (failure) {
        if (!requestSignal.aborted) {
          setMastersError(getApiErrorMessage(failure));
        }
      } finally {
        if (!requestSignal.aborted) {
          setMastersLoading(false);
        }
      }
    },
    [canCreate, isOnline],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadMasters(controller.signal);

    return () => controller.abort();
  }, [loadMasters]);

  const updateForm = (
    field: "customerId" | "notes",
    value: string,
  ): void => {
    submissionKeyRef.current = null;
    setFormError(null);

    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const updateLine = (
    clientId: string,
    field: "productId" | "quantity" | "unitPrice",
    value: string,
  ): void => {
    submissionKeyRef.current = null;
    setFormError(null);

    setForm((current) => ({
      ...current,
      lines: current.lines.map((line) => {
        if (line.clientId !== clientId) {
          return line;
        }

        if (field === "productId") {
          return {
            ...line,
            productId: value,
            quantity: "",
            unitPrice: "",
          };
        }

        return {
          ...line,
          [field]: value,
        };
      }),
    }));
  };

  const addLine = (): void => {
    if (form.lines.length >= MAX_ORDER_ITEMS) {
      setFormError(
        `An order cannot contain more than ${MAX_ORDER_ITEMS} line items.`,
      );
      return;
    }

    submissionKeyRef.current = null;
    setFormError(null);

    setForm((current) => ({
      ...current,
      lines: [...current.lines, newOrderLine()],
    }));
  };

  const removeLine = (clientId: string): void => {
    if (form.lines.length <= 1) {
      return;
    }

    submissionKeyRef.current = null;
    setFormError(null);

    setForm((current) => ({
      ...current,
      lines: current.lines.filter(
        (line) => line.clientId !== clientId,
      ),
    }));
  };

  const validateForm = (): string | null => {
    if (!selectedCustomer) {
      return "Select an active customer.";
    }

    if (form.notes.length > MAX_NOTES_LENGTH) {
      return "Order notes exceed the permitted length.";
    }

    if (
      form.lines.length === 0 ||
      form.lines.length > MAX_ORDER_ITEMS
    ) {
      return "The order must contain a valid number of items.";
    }

    const selectedProductIds = new Set<string>();

    for (const [index, line] of form.lines.entries()) {
      const product = productsById.get(line.productId);

      if (!product) {
        return `Select an active product for line ${index + 1}.`;
      }

      if (selectedProductIds.has(product.id)) {
        return `Product ${product.name} appears more than once. Combine duplicate lines.`;
      }

      selectedProductIds.add(product.id);

      if (
        !isPositiveDecimal(line.quantity) ||
        !hasAtMostDecimalPlaces(line.quantity, 6)
      ) {
        return `Enter a valid positive quantity for line ${index + 1}.`;
      }

      if (
        !isNonNegativeDecimal(line.unitPrice) ||
        !hasAtMostDecimalPlaces(line.unitPrice, 2)
      ) {
        return `Enter a valid non-negative unit price for line ${index + 1}.`;
      }
    }

    return null;
  };

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      !canCreate ||
      !isOnline ||
      saving ||
      submittedRef.current ||
      mastersLoading ||
      mastersError
    ) {
      return;
    }

    const validationError = validateForm();

    if (validationError) {
      setFormError(validationError);
      return;
    }

    const key =
      submissionKeyRef.current ?? crypto.randomUUID();

    submissionKeyRef.current = key;

    const payload: SalesOrderInput = {
      customer_id: form.customerId,
      notes: form.notes.trim() || null,
      items: form.lines.map((line) => {
        const product = productsById.get(line.productId);

        if (!product) {
          throw new Error("Selected product is unavailable.");
        }

        const unit: UnitOfMeasure = product.base_unit;

        return {
          product_id: product.id,
          quantity: line.quantity.trim(),
          unit,
          unit_price: line.unitPrice.trim(),
        };
      }),
    };

    setSaving(true);
    setFormError(null);
    setSuccessMessage(null);

    try {
      const created = await createSalesOrder(payload, key);

      submittedRef.current = true;
      submissionKeyRef.current = null;

      setSuccessMessage(
        `Sales order ${created.order_number} was created successfully.`,
      );

      navigate("/sales/orders", {
        replace: true,
      });
    } catch (failure) {
      setFormError(getApiErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  if (!canCreate) {
    return (
      <div className="app-page space-y-5">
        <h2 className="app-page-title">Create Sales Order</h2>

        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          Sales order creation is restricted to authorized sales
          and factory administration roles.
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

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <ClipboardList
                size={26}
                className="text-primary"
                aria-hidden="true"
              />

              <h2 className="app-page-title">
                Create Sales Order
              </h2>
            </div>

            <p className="app-page-description">
              Capture customer demand using active products and
              submit the order to the backend for validation.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              void loadMasters();
            }}
            disabled={mastersLoading || saving || !isOnline}
            className="app-button app-button-secondary inline-flex items-center gap-2"
          >
            <RefreshCw
              size={17}
              className={
                mastersLoading ? "motion-safe:animate-spin" : ""
              }
              aria-hidden="true"
            />
            Refresh masters
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

          <div>
            <p className="font-medium">
              Backend connection unavailable
            </p>

            <p className="mt-1 text-sm">
              Official sales orders cannot be created while
              offline. Offline order capture uses a separate
              local-draft and synchronization workflow.
            </p>

            {user?.role === USER_ROLES.SALESMAN && (
              <Link
                to="/offline/orders"
                className="mt-2 inline-flex text-sm font-semibold text-accent hover:underline"
              >
                Open offline orders
              </Link>
            )}
          </div>
        </div>
      )}

      {mastersError && (
        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          <p>{mastersError}</p>

          <button
            type="button"
            onClick={() => {
              void loadMasters();
            }}
            disabled={mastersLoading || !isOnline}
            className="mt-3 text-sm font-medium underline"
          >
            Retry loading master data
          </button>
        </div>
      )}

      {formError && (
        <div
          role="alert"
          className="app-alert app-alert-error flex items-start gap-3"
        >
          <AlertCircle
            size={19}
            className="shrink-0"
            aria-hidden="true"
          />

          <div>
            <p>{formError}</p>

            <p className="mt-1 text-xs">
              If a submission response was interrupted, verify
              the order register before retrying. The same
              idempotency key is retained until the form changes.
            </p>
          </div>
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          className="app-alert app-alert-success flex items-start gap-2"
        >
          <CheckCircle2
            size={19}
            className="shrink-0"
            aria-hidden="true"
          />
          {successMessage}
        </div>
      )}

      {mastersLoading ? (
        <LoadingState
          variant="section"
          message="Loading customers and products..."
        />
      ) : (
        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className="space-y-6"
        >
          <section className="app-card space-y-5">
            <div>
              <h3 className="text-base font-semibold text-text-primary">
                Customer information
              </h3>

              <p className="mt-1 text-sm text-text-muted">
                Select the customer receiving this sales order.
              </p>
            </div>

            <div>
              <label
                htmlFor="create-order-customer"
                className="app-field-label mb-2 block"
              >
                Customer *
              </label>

              <select
                id="create-order-customer"
                value={form.customerId}
                onChange={(event) =>
                  updateForm("customerId", event.target.value)
                }
                required
                disabled={saving || !isOnline}
                className="app-select w-full"
              >
                <option value="">Select customer</option>

                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.customer_code} — {customer.name}
                  </option>
                ))}
              </select>

              {customers.length === 0 && (
                <p className="app-field-help mt-2">
                  No active customers are available.
                </p>
              )}
            </div>

            {selectedCustomer && (
              <div className="grid gap-4 rounded-control border border-border bg-background p-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-text-muted">
                    Customer code
                  </p>

                  <p className="mt-1 text-sm font-medium text-text-primary">
                    {selectedCustomer.customer_code}
                  </p>
                </div>

                <div>
                  <p className="text-xs text-text-muted">
                    GSTIN
                  </p>

                  <p className="mt-1 text-sm font-medium text-text-primary">
                    {selectedCustomer.gstin || "Not registered"}
                  </p>
                </div>
              </div>
            )}
          </section>

          <section className="app-card space-y-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="text-base font-semibold text-text-primary">
                  Order items
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  Enter product quantities and unit prices.
                  Authoritative order values and GST are
                  validated by the backend.
                </p>
              </div>

              <button
                type="button"
                onClick={addLine}
                disabled={
                  saving ||
                  !isOnline ||
                  form.lines.length >= MAX_ORDER_ITEMS
                }
                className="app-button app-button-secondary inline-flex items-center gap-2"
              >
                <Plus size={17} aria-hidden="true" />
                Add item
              </button>
            </div>

            <div className="space-y-4">
              {form.lines.map((line, index) => {
                const selectedProduct = productsById.get(
                  line.productId,
                );

                return (
                  <div
                    key={line.clientId}
                    className="rounded-control border border-border bg-background p-4"
                  >
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <h4 className="text-sm font-semibold text-text-primary">
                        Item {index + 1}
                      </h4>

                      <button
                        type="button"
                        onClick={() => removeLine(line.clientId)}
                        disabled={saving || form.lines.length <= 1}
                        className="inline-flex items-center gap-1 text-sm font-medium text-error disabled:opacity-50"
                        aria-label={`Remove item ${index + 1}`}
                      >
                        <Trash2
                          size={16}
                          aria-hidden="true"
                        />
                        Remove
                      </button>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      <div>
                        <label
                          htmlFor={`order-product-${line.clientId}`}
                          className="app-field-label mb-2 block"
                        >
                          Product *
                        </label>

                        <select
                          id={`order-product-${line.clientId}`}
                          value={line.productId}
                          onChange={(event) =>
                            updateLine(
                              line.clientId,
                              "productId",
                              event.target.value,
                            )
                          }
                          required
                          disabled={saving || !isOnline}
                          className="app-select w-full"
                        >
                          <option value="">
                            Select product
                          </option>

                          {products.map((product) => (
                            <option
                              key={product.id}
                              value={product.id}
                            >
                              {getProductLabel(product)}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label
                          htmlFor={`order-quantity-${line.clientId}`}
                          className="app-field-label mb-2 block"
                        >
                          Quantity *
                        </label>

                        <input
                          id={`order-quantity-${line.clientId}`}
                          type="text"
                          inputMode="decimal"
                          value={line.quantity}
                          onChange={(event) =>
                            updateLine(
                              line.clientId,
                              "quantity",
                              event.target.value,
                            )
                          }
                          required
                          disabled={saving || !isOnline}
                          placeholder="0"
                          className="app-input w-full"
                        />

                        {selectedProduct && (
                          <p className="app-field-help mt-1">
                            Unit: {selectedProduct.base_unit}
                          </p>
                        )}
                      </div>

                      <div>
                        <label
                          htmlFor={`order-price-${line.clientId}`}
                          className="app-field-label mb-2 block"
                        >
                          Unit price (₹) *
                        </label>

                        <input
                          id={`order-price-${line.clientId}`}
                          type="text"
                          inputMode="decimal"
                          value={line.unitPrice}
                          onChange={(event) =>
                            updateLine(
                              line.clientId,
                              "unitPrice",
                              event.target.value,
                            )
                          }
                          required
                          disabled={saving || !isOnline}
                          placeholder="0.00"
                          className="app-input w-full"
                        />
                      </div>
                    </div>

                    {selectedProduct && (
                      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-3 text-xs text-text-muted">
                        <span>
                          SKU: {selectedProduct.sku}
                        </span>

                        <span>
                          HSN: {selectedProduct.hsn_code}
                        </span>

                        <span>
                          GST rate: {selectedProduct.gst_rate}%
                        </span>

                        <span>
                          Base unit: {selectedProduct.base_unit}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {products.length === 0 && (
              <div className="app-alert app-alert-warning">
                No active products are available for order
                creation.
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={addLine}
                disabled={
                  saving ||
                  !isOnline ||
                  form.lines.length >= MAX_ORDER_ITEMS
                }
                className="app-button app-button-secondary inline-flex items-center gap-2"
              >
                <Plus size={17} aria-hidden="true" />
                Add another item
              </button>
            </div>
          </section>

          <section className="app-card space-y-4">
            <div>
              <h3 className="text-base font-semibold text-text-primary">
                Additional information
              </h3>

              <p className="mt-1 text-sm text-text-muted">
                Optional notes for order review and fulfillment.
              </p>
            </div>

            <div>
              <label
                htmlFor="create-order-notes"
                className="app-field-label mb-2 block"
              >
                Order notes
              </label>

              <textarea
                id="create-order-notes"
                rows={4}
                maxLength={MAX_NOTES_LENGTH}
                value={form.notes}
                onChange={(event) =>
                  updateForm("notes", event.target.value)
                }
                disabled={saving || !isOnline}
                className="app-textarea w-full"
              />

              <p className="app-field-help mt-1">
                {form.notes.length}/{MAX_NOTES_LENGTH} characters
              </p>
            </div>
          </section>

          <section className="app-card space-y-4">
            <div>
              <h3 className="text-base font-semibold text-text-primary">
                Submission summary
              </h3>

              <p className="mt-1 text-sm text-text-muted">
                This screen does not calculate or post GST,
                inventory deductions, invoices, or payments.
              </p>
            </div>

            <div className="grid gap-4 rounded-control bg-background p-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-text-muted">
                  Customer
                </p>

                <p className="mt-1 text-sm font-medium text-text-primary">
                  {selectedCustomer?.name ?? "Not selected"}
                </p>
              </div>

              <div>
                <p className="text-xs text-text-muted">
                  Number of lines
                </p>

                <p className="mt-1 text-sm font-medium text-text-primary">
                  {form.lines.length}
                </p>
              </div>

              <div>
                <p className="text-xs text-text-muted">
                  Pricing
                </p>

                <p className="mt-1 text-sm font-medium text-text-primary">
                  Backend validated
                </p>
              </div>
            </div>

            <div className="rounded-control border border-border p-4">
              <p className="text-xs leading-5 text-text-muted">
                Sales order submission does not itself create
                a GST invoice or deduct finished-goods stock.
                Approval, invoicing, dispatch, and payment
                collection remain separate backend-controlled
                business workflows.
              </p>
            </div>

            <div className="flex flex-wrap justify-end gap-3">
              <Link
                to="/sales/orders"
                className="app-button app-button-secondary"
              >
                Cancel
              </Link>

              <button
                type="submit"
                disabled={
                  saving ||
                  !isOnline ||
                  mastersLoading ||
                  Boolean(mastersError) ||
                  customers.length === 0 ||
                  products.length === 0 ||
                  submittedRef.current
                }
                className="app-button app-button-primary inline-flex items-center gap-2"
              >
                <Save
                  size={17}
                  aria-hidden="true"
                />

                {saving
                  ? "Submitting..."
                  : "Create sales order"}
              </button>
            </div>
          </section>
        </form>
      )}

      <div className="rounded-card border border-border bg-surface p-4">
        <p className="text-xs leading-5 text-text-muted">
          Product quantities are recorded in their base units.
          Product prices and quantities are subject to backend
          validation. {formatCurrency("0")} and{" "}
          {formatQuantity("0")} are display-format examples only;
          no financial or stock values are calculated locally.
        </p>
      </div>
    </div>
  );
}

export default CreateOrderPage;
