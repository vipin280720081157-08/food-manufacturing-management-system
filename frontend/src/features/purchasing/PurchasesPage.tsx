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
  CheckCircle2,
  ClipboardList,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

import type {
  InventoryItem,
  PaginatedResponse,
  Supplier,
  UUID,
} from "../../types/business";

import { USER_ROLES } from "../../types/auth";
import { useAuth } from "../../hooks/useAuth";

import {
  apiClient,
  getApiErrorMessage,
} from "../../services/api/client";

import {
  getSuppliers,
  getInventoryItems,
} from "../../services/api/mastersApi";

import {
  DataTable,
  type DataTableColumn,
} from "../../components/tables/DataTable";

import {
  LoadingState,
} from "../../components/common/LoadingState";

import {
  StatusBadge,
} from "../../components/common/StatusBadge";

import {
  ConfirmDialog,
} from "../../components/common/ConfirmDialog";

import {
  FormField,
  SelectField,
  TextareaField,
} from "../../components/forms/FormField";

import {
  formatCurrency,
  formatDate,
  formatQuantity,
} from "../../utils/formatters";

const PAGE_SIZE = 20;
const REFERENCE_PAGE_SIZE = 100;

type PurchaseStatus =
  | "draft"
  | "posted"
  | "cancelled";

interface PurchaseOrderItem {
  id: UUID;
  purchase_order_id: UUID;
  item_id: UUID;
  quantity: string;
  unit: InventoryItem["base_unit"];
  unit_price: string;
  line_total: string;
}

interface PurchaseOrder {
  id: UUID;
  purchase_order_number: string;
  supplier_id: UUID;
  purchase_date: string;
  status: PurchaseStatus;
  notes: string | null;
  total_amount: string;
  items: PurchaseOrderItem[];
  created_at: string;
  updated_at: string | null;
}

interface PurchaseOrderSummary
  extends Omit<PurchaseOrder, "items"> {
  items?: PurchaseOrderItem[];
}

interface PurchaseItemInput {
  item_id: UUID;
  quantity: string;
  unit: InventoryItem["base_unit"];
  unit_price: string;
}

interface PurchaseOrderPayload {
  supplier_id: UUID;
  purchase_date: string;
  notes: string | null;
  items: PurchaseItemInput[];
}

interface EditablePurchaseItem {
  localId: string;
  itemId: string;
  quantity: string;
  unitPrice: string;
}

interface PurchaseFormValues {
  supplierId: string;
  purchaseDate: string;
  notes: string;
  items: EditablePurchaseItem[];
}

interface PurchaseFormErrors {
  supplierId?: string;
  purchaseDate?: string;
  items?: string;
  itemErrors: Record<string, string>;
}

interface PurchaseFormProps {
  purchase: PurchaseOrder | null;
  suppliers: readonly Supplier[];
  inventoryItems: readonly InventoryItem[];
  referencesLoading: boolean;
  referencesError: string | null;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (
    payload: PurchaseOrderPayload,
  ) => Promise<void>;
}

interface PurchaseDetailsProps {
  purchase: PurchaseOrder;
  suppliers: readonly Supplier[];
  inventoryItems: readonly InventoryItem[];
  onClose: () => void;
}

function todayISO(): string {
  const date = new Date();

  const year = date.getFullYear();
  const month = String(
    date.getMonth() + 1,
  ).padStart(2, "0");
  const day = String(
    date.getDate(),
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function createEditableItem(
  itemId = "",
  quantity = "",
  unitPrice = "",
): EditablePurchaseItem {
  return {
    localId: crypto.randomUUID(),
    itemId,
    quantity,
    unitPrice,
  };
}

function createEmptyForm(): PurchaseFormValues {
  return {
    supplierId: "",
    purchaseDate: todayISO(),
    notes: "",
    items: [createEditableItem()],
  };
}

function toFormValues(
  purchase: PurchaseOrder,
): PurchaseFormValues {
  return {
    supplierId: purchase.supplier_id,
    purchaseDate: purchase.purchase_date,
    notes: purchase.notes ?? "",
    items:
      purchase.items.length > 0
        ? purchase.items.map((item) =>
            createEditableItem(
              item.item_id,
              item.quantity,
              item.unit_price,
            ),
          )
        : [createEditableItem()],
  };
}

function normalizeDecimal(
  value: string,
): string {
  const trimmed = value.trim();

  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }

  const [whole = "0", fraction] =
    trimmed.split(".");

  const normalizedWhole =
    whole.replace(/^0+(?=\d)/, "") || "0";

  const normalizedFraction =
    fraction?.replace(/0+$/, "");

  return normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
}

function isPositiveDecimal(
  value: string,
): boolean {
  const normalized = normalizeDecimal(value);

  return (
    /^\d+(?:\.\d+)?$/.test(normalized) &&
    /[1-9]/.test(normalized)
  );
}

function isValidMoney(
  value: string,
): boolean {
  const normalized = normalizeDecimal(value);

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return false;
  }

  const [whole = "0"] = normalized.split(".");

  return whole.length <= 15;
}

function isValidDate(
  value: string,
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function validateForm(
  values: PurchaseFormValues,
  suppliers: readonly Supplier[],
  inventoryItems: readonly InventoryItem[],
): PurchaseFormErrors {
  const errors: PurchaseFormErrors = {
    itemErrors: {},
  };

  const supplier = suppliers.find(
    (entry) => entry.id === values.supplierId,
  );

  if (!supplier) {
    errors.supplierId =
      "Select a valid supplier.";
  } else if (!supplier.is_active) {
    errors.supplierId =
      "An inactive supplier cannot be selected for a new purchase.";
  }

  if (!isValidDate(values.purchaseDate)) {
    errors.purchaseDate =
      "Enter a valid purchase date.";
  }

  if (values.items.length === 0) {
    errors.items =
      "Add at least one purchase item.";
  }

  const selectedIds = new Set<string>();

  for (const item of values.items) {
    const inventoryItem = inventoryItems.find(
      (entry) => entry.id === item.itemId,
    );

    if (!inventoryItem) {
      errors.itemErrors[item.localId] =
        "Select a valid inventory item.";
      continue;
    }

    if (
      inventoryItem.item_type ===
      "finished_product"
    ) {
      errors.itemErrors[item.localId] =
        "Select a raw material or packaging material.";
      continue;
    }

    if (!inventoryItem.is_active) {
      errors.itemErrors[item.localId] =
        "Inactive inventory items cannot be purchased.";
      continue;
    }

    if (selectedIds.has(item.itemId)) {
      errors.itemErrors[item.localId] =
        "This item is already included.";
      continue;
    }

    selectedIds.add(item.itemId);

    if (!isPositiveDecimal(item.quantity)) {
      errors.itemErrors[item.localId] =
        "Quantity must be greater than zero.";
      continue;
    }

    if (!isValidMoney(item.unitPrice)) {
      errors.itemErrors[item.localId] =
        "Enter a valid nonnegative unit price with up to two decimal places.";
    }
  }

  return errors;
}

function hasValidationErrors(
  errors: PurchaseFormErrors,
): boolean {
  return Boolean(
    errors.supplierId ||
      errors.purchaseDate ||
      errors.items ||
      Object.keys(errors.itemErrors).length > 0,
  );
}

function toPayload(
  values: PurchaseFormValues,
  inventoryItems: readonly InventoryItem[],
): PurchaseOrderPayload {
  return {
    supplier_id: values.supplierId,
    purchase_date: values.purchaseDate,
    notes: values.notes.trim() || null,
    items: values.items.map((item) => {
      const inventoryItem = inventoryItems.find(
        (entry) => entry.id === item.itemId,
      );

      if (!inventoryItem) {
        throw new Error(
          "The selected inventory item is unavailable.",
        );
      }

      return {
        item_id: item.itemId,
        quantity: normalizeDecimal(item.quantity),
        unit: inventoryItem.base_unit,
        unit_price: normalizeDecimal(
          item.unitPrice,
        ),
      };
    }),
  };
}

async function fetchPurchaseOrders(
  page: number,
  search: string,
  signal?: AbortSignal,
): Promise<PaginatedResponse<PurchaseOrderSummary>> {
  return apiClient.get<
    PaginatedResponse<PurchaseOrderSummary>
  >("/purchase-orders", {
    query: {
      page,
      page_size: PAGE_SIZE,
      search: search || undefined,
    },
    signal,
  });
}

async function fetchPurchaseOrder(
  id: UUID,
  signal?: AbortSignal,
): Promise<PurchaseOrder> {
  return apiClient.get<PurchaseOrder>(
    `/purchase-orders/${encodeURIComponent(id)}`,
    { signal },
  );
}

async function createPurchaseOrder(
  payload: PurchaseOrderPayload,
): Promise<PurchaseOrder> {
  return apiClient.post<PurchaseOrder>(
    "/purchase-orders",
    payload,
  );
}

async function updatePurchaseOrder(
  id: UUID,
  payload: PurchaseOrderPayload,
): Promise<PurchaseOrder> {
  return apiClient.put<PurchaseOrder>(
    `/purchase-orders/${encodeURIComponent(id)}`,
    payload,
  );
}

async function fetchAllSuppliers(
  signal?: AbortSignal,
): Promise<Supplier[]> {
  const results: Supplier[] = [];
  let page = 1;

  while (true) {
    const response = await getSuppliers(
      {
        page,
        page_size: REFERENCE_PAGE_SIZE,
      },
      { signal },
    );

    results.push(...response.items);

    if (
      results.length >= response.total ||
      response.items.length === 0
    ) {
      break;
    }

    page += 1;
  }

  return results;
}

async function fetchAllInventoryItems(
  signal?: AbortSignal,
): Promise<InventoryItem[]> {
  const results: InventoryItem[] = [];
  let page = 1;

  while (true) {
    const response = await getInventoryItems(
      {
        page,
        page_size: REFERENCE_PAGE_SIZE,
      },
      { signal },
    );

    results.push(...response.items);

    if (
      results.length >= response.total ||
      response.items.length === 0
    ) {
      break;
    }

    page += 1;
  }

  return results;
}

function PurchaseForm({
  purchase,
  suppliers,
  inventoryItems,
  referencesLoading,
  referencesError,
  saving,
  error,
  onCancel,
  onSubmit,
}: PurchaseFormProps) {
  const [values, setValues] =
    useState<PurchaseFormValues>(() =>
      purchase
        ? toFormValues(purchase)
        : createEmptyForm(),
    );

  const [errors, setErrors] =
    useState<PurchaseFormErrors>({
      itemErrors: {},
    });

  const submittingRef = useRef(false);

  const availableSuppliers = useMemo(
    () =>
      suppliers.filter(
        (supplier) =>
          supplier.is_active ||
          supplier.id === values.supplierId,
      ),
    [suppliers, values.supplierId],
  );

  const availableItems = useMemo(() => {
    const selectedIds = new Set(
      values.items.map((item) => item.itemId),
    );

    return inventoryItems.filter(
      (item) =>
        item.item_type !== "finished_product" &&
        (item.is_active ||
          selectedIds.has(item.id)),
    );
  }, [inventoryItems, values.items]);

  const itemMap = useMemo(
    () =>
      new Map(
        inventoryItems.map((item) => [
          item.id,
          item,
        ]),
      ),
    [inventoryItems],
  );

  const updateField = <
    K extends keyof PurchaseFormValues,
  >(
    field: K,
    value: PurchaseFormValues[K],
  ): void => {
    setValues((current) => ({
      ...current,
      [field]: value,
    }));

    setErrors((current) => ({
      ...current,
      [field]: undefined,
    }));
  };

  const updateItem = (
    localId: string,
    field: "itemId" | "quantity" | "unitPrice",
    value: string,
  ): void => {
    setValues((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.localId === localId
          ? {
              ...item,
              [field]: value,
            }
          : item,
      ),
    }));

    setErrors((current) => {
      const itemErrors = {
        ...current.itemErrors,
      };

      delete itemErrors[localId];

      return {
        ...current,
        items: undefined,
        itemErrors,
      };
    });
  };

  const addItem = (): void => {
    setValues((current) => ({
      ...current,
      items: [
        ...current.items,
        createEditableItem(),
      ],
    }));

    setErrors((current) => ({
      ...current,
      items: undefined,
    }));
  };

  const removeItem = (
    localId: string,
  ): void => {
    setValues((current) => ({
      ...current,
      items: current.items.filter(
        (item) => item.localId !== localId,
      ),
    }));

    setErrors((current) => {
      const itemErrors = {
        ...current.itemErrors,
      };

      delete itemErrors[localId];

      return {
        ...current,
        itemErrors,
      };
    });
  };

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      saving ||
      referencesLoading ||
      referencesError ||
      submittingRef.current
    ) {
      return;
    }

    const validationErrors = validateForm(
      values,
      suppliers,
      inventoryItems,
    );

    setErrors(validationErrors);

    if (hasValidationErrors(validationErrors)) {
      return;
    }

    submittingRef.current = true;

    try {
      await onSubmit(
        toPayload(values, inventoryItems),
      );
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      noValidate
      aria-busy={saving}
      className="space-y-6"
    >
      <fieldset className="space-y-4">
        <legend className="mb-4 text-sm font-semibold text-text-primary">
          Purchase information
        </legend>

        <SelectField
          label="Supplier"
          name="supplier_id"
          value={values.supplierId}
          options={availableSuppliers.map(
            (supplier) => ({
              value: supplier.id,
              label: `${supplier.name} (${supplier.supplier_code})`,
              disabled: !supplier.is_active,
            }),
          )}
          placeholder="Select supplier"
          onChange={(event) =>
            updateField(
              "supplierId",
              event.target.value,
            )
          }
          error={errors.supplierId}
          required
          disabled={saving || referencesLoading}
        />

        <FormField
          label="Purchase date"
          name="purchase_date"
          type="date"
          value={values.purchaseDate}
          onChange={(event) =>
            updateField(
              "purchaseDate",
              event.target.value,
            )
          }
          error={errors.purchaseDate}
          required
          disabled={saving}
        />

        <TextareaField
          label="Notes"
          name="notes"
          value={values.notes}
          onChange={(event) =>
            updateField(
              "notes",
              event.target.value,
            )
          }
          disabled={saving}
          rows={3}
          maxLength={2000}
        />
      </fieldset>

      <fieldset className="space-y-4 border-t border-border pt-5">
        <legend className="text-sm font-semibold text-text-primary">
          Purchase items
        </legend>

        <p className="text-xs leading-5 text-text-muted">
          Purchase quantities use the selected
          inventory item's base unit. The backend
          validates prices, quantities, and purchase
          totals.
        </p>

        {referencesLoading && (
          <LoadingState
            variant="inline"
            message="Loading suppliers and inventory items..."
          />
        )}

        {referencesError && (
          <div
            role="alert"
            className="app-alert app-alert-error"
          >
            {referencesError}
          </div>
        )}

        {values.items.map((item, index) => {
          const selectedItem =
            itemMap.get(item.itemId);

          const itemError =
            errors.itemErrors[item.localId];

          return (
            <div
              key={item.localId}
              className="space-y-4 rounded-control border border-border bg-background p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-text-primary">
                  Item {index + 1}
                </h4>

                <button
                  type="button"
                  onClick={() =>
                    removeItem(item.localId)
                  }
                  disabled={saving}
                  aria-label={`Remove purchase item ${index + 1}`}
                  className="rounded-control px-2 py-1 text-xs font-medium text-error hover:bg-error/10 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                >
                  Remove
                </button>
              </div>

              <div>
                <label
                  htmlFor={`purchase-item-${item.localId}`}
                  className="app-field-label mb-2 block"
                >
                  Inventory item
                </label>

                <select
                  id={`purchase-item-${item.localId}`}
                  value={item.itemId}
                  onChange={(event) =>
                    updateItem(
                      item.localId,
                      "itemId",
                      event.target.value,
                    )
                  }
                  disabled={
                    saving || referencesLoading
                  }
                  required
                  aria-invalid={Boolean(itemError)}
                  className="app-select w-full"
                >
                  <option value="">
                    Select inventory item
                  </option>

                  {availableItems.map(
                    (inventoryItem) => (
                      <option
                        key={inventoryItem.id}
                        value={inventoryItem.id}
                        disabled={
                          !inventoryItem.is_active
                        }
                      >
                        {inventoryItem.name} (
                        {inventoryItem.item_code})
                      </option>
                    ),
                  )}
                </select>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor={`purchase-quantity-${item.localId}`}
                    className="app-field-label mb-2 block"
                  >
                    Quantity
                    {selectedItem
                      ? ` (${selectedItem.base_unit})`
                      : ""}
                  </label>

                  <input
                    id={`purchase-quantity-${item.localId}`}
                    type="text"
                    inputMode="decimal"
                    value={item.quantity}
                    onChange={(event) =>
                      updateItem(
                        item.localId,
                        "quantity",
                        event.target.value,
                      )
                    }
                    disabled={saving}
                    required
                    placeholder="0"
                    aria-invalid={Boolean(itemError)}
                    className="app-input w-full"
                  />
                </div>

                <div>
                  <label
                    htmlFor={`purchase-price-${item.localId}`}
                    className="app-field-label mb-2 block"
                  >
                    Unit price (₹)
                  </label>

                  <input
                    id={`purchase-price-${item.localId}`}
                    type="text"
                    inputMode="decimal"
                    value={item.unitPrice}
                    onChange={(event) =>
                      updateItem(
                        item.localId,
                        "unitPrice",
                        event.target.value,
                      )
                    }
                    disabled={saving}
                    required
                    placeholder="0.00"
                    aria-invalid={Boolean(itemError)}
                    className="app-input w-full"
                  />
                </div>
              </div>

              {itemError && (
                <p
                  role="alert"
                  className="app-field-error"
                >
                  {itemError}
                </p>
              )}
            </div>
          );
        })}

        {errors.items && (
          <p
            role="alert"
            className="app-field-error"
          >
            {errors.items}
          </p>
        )}

        <button
          type="button"
          onClick={addItem}
          disabled={
            saving ||
            referencesLoading ||
            Boolean(referencesError)
          }
          className="app-button app-button-secondary inline-flex items-center gap-2"
        >
          <Plus
            size={17}
            aria-hidden="true"
          />

          Add purchase item
        </button>
      </fieldset>

      <div className="rounded-control border border-border bg-background p-4">
        <p className="text-xs leading-5 text-text-muted">
          Saving a purchase order does not increase
          inventory. Actual received quantities,
          batches, and stock movements must be
          recorded through Goods Receipts.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="app-alert app-alert-error"
        >
          {error}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-3 border-t border-border pt-5">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="app-button app-button-secondary"
        >
          Cancel
        </button>

        <button
          type="submit"
          disabled={
            saving ||
            referencesLoading ||
            Boolean(referencesError)
          }
          className="app-button app-button-primary"
        >
          {saving
            ? "Saving..."
            : purchase
              ? "Save changes"
              : "Create purchase"}
        </button>
      </div>
    </form>
  );
}

function PurchaseDetails({
  purchase,
  suppliers,
  inventoryItems,
  onClose,
}: PurchaseDetailsProps) {
  const supplier = suppliers.find(
    (entry) =>
      entry.id === purchase.supplier_id,
  );

  const itemMap = useMemo(
    () =>
      new Map(
        inventoryItems.map((item) => [
          item.id,
          item,
        ]),
      ),
    [inventoryItems],
  );

  return (
    <div className="space-y-6">
      <dl className="grid gap-5 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-text-muted">
            Purchase order number
          </dt>

          <dd className="mt-1 font-medium text-text-primary">
            {purchase.purchase_order_number}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Status
          </dt>

          <dd className="mt-1">
            <StatusBadge
              status={purchase.status}
              category="transaction"
              showDot
            />
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Supplier
          </dt>

          <dd className="mt-1 text-text-primary">
            {supplier?.name ??
              purchase.supplier_id}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Purchase date
          </dt>

          <dd className="mt-1 text-text-primary">
            {formatDate(purchase.purchase_date)}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Total amount
          </dt>

          <dd className="mt-1 font-semibold text-text-primary">
            {formatCurrency(
              purchase.total_amount,
            )}
          </dd>
        </div>
      </dl>

      <div className="border-t border-border pt-4">
        <h4 className="mb-3 text-sm font-semibold text-text-primary">
          Purchase items
        </h4>

        <div className="app-table-container">
          <table className="app-table">
            <thead>
              <tr>
                <th scope="col">
                  Item
                </th>

                <th scope="col">
                  Quantity
                </th>

                <th scope="col">
                  Unit price
                </th>

                <th scope="col">
                  Line total
                </th>
              </tr>
            </thead>

            <tbody>
              {purchase.items.map((item) => {
                const inventoryItem =
                  itemMap.get(item.item_id);

                return (
                  <tr key={item.id}>
                    <td>
                      {inventoryItem?.name ??
                        item.item_id}
                    </td>

                    <td>
                      {formatQuantity(
                        item.quantity,
                      )}{" "}
                      {item.unit}
                    </td>

                    <td className="app-numeric">
                      {formatCurrency(
                        item.unit_price,
                      )}
                    </td>

                    <td className="app-numeric">
                      {formatCurrency(
                        item.line_total,
                      )}
                    </td>
                  </tr>
                );
              })}

              {purchase.items.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="py-6 text-center text-text-muted"
                  >
                    No purchase items recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {purchase.notes && (
        <div className="border-t border-border pt-4">
          <h4 className="text-sm font-semibold text-text-primary">
            Notes
          </h4>

          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-muted">
            {purchase.notes}
          </p>
        </div>
      )}

      <div className="rounded-control border border-border bg-background p-4 text-xs leading-5 text-text-muted">
        Purchase records and goods receipts are
        separate transactions. Inventory increases
        only when the backend posts an authorized
        goods receipt.
      </div>

      <div className="flex justify-end border-t border-border pt-5">
        <button
          type="button"
          onClick={onClose}
          className="app-button app-button-secondary"
        >
          Close
        </button>
      </div>
    </div>
  );
}

export function PurchasesPage() {
  const { user } = useAuth();

  const canManagePurchases =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [purchases, setPurchases] =
    useState<PurchaseOrderSummary[]>([]);

  const [suppliers, setSuppliers] =
    useState<Supplier[]>([]);

  const [inventoryItems, setInventoryItems] =
    useState<InventoryItem[]>([]);

  const [total, setTotal] =
    useState(0);

  const [page, setPage] =
    useState(1);

  const [searchInput, setSearchInput] =
    useState("");

  const [search, setSearch] =
    useState("");

  const [loading, setLoading] =
    useState(true);

  const [referencesLoading, setReferencesLoading] =
    useState(true);

  const [detailsLoading, setDetailsLoading] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  const [referencesError, setReferencesError] =
    useState<string | null>(null);

  const [detailsError, setDetailsError] =
    useState<string | null>(null);

  const [successMessage, setSuccessMessage] =
    useState<string | null>(null);

  const [dialogOpen, setDialogOpen] =
    useState(false);

  const [dialogMode, setDialogMode] =
    useState<"create" | "edit" | "view">(
      "create",
    );

  const [editingPurchase, setEditingPurchase] =
    useState<PurchaseOrder | null>(null);

  const [viewingPurchase, setViewingPurchase] =
    useState<PurchaseOrder | null>(null);

  const [saving, setSaving] =
    useState(false);

  const [formError, setFormError] =
    useState<string | null>(null);

  const [postingPurchase, setPostingPurchase] =
    useState<PurchaseOrderSummary | null>(null);

  const [posting, setPosting] =
    useState(false);

  const [postingError, setPostingError] =
    useState<string | null>(null);

  const detailsRequestRef = useRef(0);
  const saveRequestRef = useRef(false);
  const postRequestRef = useRef(false);

  const loadPurchases = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<void> => {
      setLoading(true);
      setError(null);

      try {
        const response =
          await fetchPurchaseOrders(
            page,
            search,
            signal,
          );

        if (signal?.aborted) {
          return;
        }

        setPurchases(response.items);
        setTotal(response.total);
      } catch (failure) {
        if (signal?.aborted) {
          return;
        }

        setError(
          getApiErrorMessage(failure),
        );
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [page, search],
  );

  const loadReferences = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<void> => {
      setReferencesLoading(true);
      setReferencesError(null);

      try {
        const [supplierResults, itemResults] =
          await Promise.all([
            fetchAllSuppliers(signal),
            fetchAllInventoryItems(signal),
          ]);

        if (signal?.aborted) {
          return;
        }

        setSuppliers(supplierResults);
        setInventoryItems(itemResults);
      } catch (failure) {
        if (signal?.aborted) {
          return;
        }

        setReferencesError(
          getApiErrorMessage(failure),
        );
      } finally {
        if (!signal?.aborted) {
          setReferencesLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();

    void loadPurchases(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadPurchases]);

  useEffect(() => {
    const controller = new AbortController();

    void loadReferences(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadReferences]);

  const closeDialog = (): void => {
    if (saving) {
      return;
    }

    detailsRequestRef.current += 1;

    setDialogOpen(false);
    setEditingPurchase(null);
    setViewingPurchase(null);
    setDetailsLoading(false);
    setDetailsError(null);
    setFormError(null);
  };

  const openCreateDialog = (): void => {
    if (!canManagePurchases) {
      return;
    }

    setDialogMode("create");
    setEditingPurchase(null);
    setViewingPurchase(null);
    setDetailsError(null);
    setFormError(null);
    setDialogOpen(true);
  };

  const openExistingPurchase = async (
    purchase: PurchaseOrderSummary,
    mode: "view" | "edit",
  ): Promise<void> => {
    if (
      mode === "edit" &&
      (!canManagePurchases ||
        purchase.status !== "draft")
    ) {
      return;
    }

    const requestId =
      ++detailsRequestRef.current;

    setDialogMode(mode);
    setEditingPurchase(null);
    setViewingPurchase(null);
    setDetailsError(null);
    setFormError(null);
    setDetailsLoading(true);
    setDialogOpen(true);

    try {
      const details = await fetchPurchaseOrder(
        purchase.id,
      );

      if (
        requestId !==
        detailsRequestRef.current
      ) {
        return;
      }

      if (
        mode === "edit" &&
        details.status !== "draft"
      ) {
        setDetailsError(
          "Only draft purchases can be edited.",
        );
        return;
      }

      if (mode === "edit") {
        setEditingPurchase(details);
      } else {
        setViewingPurchase(details);
      }
    } catch (failure) {
      if (
        requestId !==
        detailsRequestRef.current
      ) {
        return;
      }

      setDetailsError(
        getApiErrorMessage(failure),
      );
    } finally {
      if (
        requestId ===
        detailsRequestRef.current
      ) {
        setDetailsLoading(false);
      }
    }
  };

  const handleSave = async (
    payload: PurchaseOrderPayload,
  ): Promise<void> => {
    if (
      !canManagePurchases ||
      saving ||
      saveRequestRef.current
    ) {
      return;
    }

    saveRequestRef.current = true;
    setSaving(true);
    setFormError(null);
    setSuccessMessage(null);

    try {
      if (editingPurchase) {
        await updatePurchaseOrder(
          editingPurchase.id,
          payload,
        );

        setSuccessMessage(
          "Purchase order updated successfully.",
        );
      } else {
        await createPurchaseOrder(payload);

        setSuccessMessage(
          "Purchase order created successfully.",
        );
      }

      detailsRequestRef.current += 1;

      setDialogOpen(false);
      setEditingPurchase(null);
      setViewingPurchase(null);

      await loadPurchases();
    } catch (failure) {
      setFormError(
        getApiErrorMessage(failure),
      );
    } finally {
      saveRequestRef.current = false;
      setSaving(false);
    }
  };

  const handlePostPurchase =
    async (): Promise<void> => {
      if (
        !postingPurchase ||
        !canManagePurchases ||
        posting ||
        postRequestRef.current
      ) {
        return;
      }

      const purchaseId = postingPurchase.id;

      postRequestRef.current = true;
      setPosting(true);
      setPostingError(null);
      setSuccessMessage(null);

      try {
        await apiClient.post<PurchaseOrder>(
          `/purchase-orders/${encodeURIComponent(
            purchaseId,
          )}/post`,
          {},
        );

        setPostingPurchase(null);

        setSuccessMessage(
          "Purchase order posted successfully. Inventory remains unchanged until goods receipt posting.",
        );

        await loadPurchases();
      } catch (failure) {
        setPostingError(
          getApiErrorMessage(failure),
        );
      } finally {
        postRequestRef.current = false;
        setPosting(false);
      }
    };

  const supplierMap = useMemo(
    () =>
      new Map(
        suppliers.map((supplier) => [
          supplier.id,
          supplier,
        ]),
      ),
    [suppliers],
  );

  const columns = useMemo<
    DataTableColumn<PurchaseOrderSummary>[]
  >(
    () => [
      {
        key: "purchase_order_number",
        header: "Purchase order",
        accessor: "purchase_order_number",
        render: (purchase) => (
          <span className="font-medium text-text-primary">
            {purchase.purchase_order_number}
          </span>
        ),
      },
      {
        key: "supplier",
        header: "Supplier",
        render: (purchase) =>
          supplierMap.get(purchase.supplier_id)
            ?.name ?? purchase.supplier_id,
      },
      {
        key: "purchase_date",
        header: "Date",
        render: (purchase) =>
          formatDate(purchase.purchase_date),
      },
      {
        key: "total_amount",
        header: "Total",
        render: (purchase) => (
          <span className="app-numeric">
            {formatCurrency(
              purchase.total_amount,
            )}
          </span>
        ),
        numeric: true,
      },
      {
        key: "status",
        header: "Status",
        render: (purchase) => (
          <StatusBadge
            status={purchase.status}
            category="transaction"
            showDot
          />
        ),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (purchase) => (
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();

                void openExistingPurchase(
                  purchase,
                  "view",
                );
              }}
              className="app-button app-button-secondary inline-flex items-center gap-1.5"
              aria-label={`View purchase ${purchase.purchase_order_number}`}
            >
              <Eye
                size={15}
                aria-hidden="true"
              />

              View
            </button>

            {canManagePurchases &&
              purchase.status === "draft" && (
                <>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();

                      void openExistingPurchase(
                        purchase,
                        "edit",
                      );
                    }}
                    className="app-button app-button-secondary inline-flex items-center gap-1.5"
                    aria-label={`Edit purchase ${purchase.purchase_order_number}`}
                  >
                    <Pencil
                      size={15}
                      aria-hidden="true"
                    />

                    Edit
                  </button>

                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setPostingError(null);
                      setPostingPurchase(
                        purchase,
                      );
                    }}
                    className="app-button app-button-primary"
                    aria-label={`Post purchase ${purchase.purchase_order_number}`}
                  >
                    Post
                  </button>
                </>
              )}
          </div>
        ),
      },
    ],
    [canManagePurchases, supplierMap],
  );

  const handleSearch = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();

    setPage(1);
    setSearch(searchInput.trim());
  };

  return (
    <div className="app-page space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="app-page-title">
            Purchases
          </h2>

          <p className="app-page-description">
            Record supplier purchases, review
            material quantities and prices, and
            manage purchase order status.
          </p>
        </div>

        {canManagePurchases && (
          <button
            type="button"
            onClick={openCreateDialog}
            className="app-button app-button-primary inline-flex items-center justify-center gap-2"
          >
            <Plus
              size={18}
              aria-hidden="true"
            />

            Add purchase
          </button>
        )}
      </div>

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

          <span className="flex-1">
            {successMessage}
          </span>

          <button
            type="button"
            onClick={() =>
              setSuccessMessage(null)
            }
            aria-label="Dismiss notification"
            className="rounded-control p-1 focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X
              size={17}
              aria-hidden="true"
            />
          </button>
        </div>
      )}

      <section className="app-card space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <form
            onSubmit={handleSearch}
            role="search"
            className="flex w-full max-w-md gap-2"
          >
            <label
              htmlFor="purchase-search"
              className="app-sr-only"
            >
              Search purchases
            </label>

            <div className="relative min-w-0 flex-1">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />

              <input
                id="purchase-search"
                type="search"
                value={searchInput}
                onChange={(event) =>
                  setSearchInput(
                    event.target.value,
                  )
                }
                placeholder="Search purchases..."
                className="app-input w-full pl-10"
              />
            </div>

            <button
              type="submit"
              className="app-button app-button-secondary"
            >
              Search
            </button>
          </form>

          <button
            type="button"
            onClick={() => {
              void loadPurchases();
            }}
            disabled={loading}
            className="app-button app-button-secondary inline-flex items-center justify-center gap-2"
          >
            <RefreshCw
              size={16}
              className={
                loading
                  ? "motion-safe:animate-spin"
                  : ""
              }
              aria-hidden="true"
            />

            Refresh
          </button>
        </div>

        {loading && purchases.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading purchases..."
          />
        ) : (
          <DataTable<PurchaseOrderSummary>
            columns={columns}
            data={purchases}
            getRowId={(purchase) =>
              purchase.id
            }
            loading={loading}
            error={error}
            onRetry={() =>
              loadPurchases()
            }
            emptyMessage="No purchases found"
            emptyDescription={
              search
                ? "Try another search term."
                : "No purchase records are available."
            }
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="purchases-table"
          />
        )}
      </section>

      <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
        <ClipboardList
          size={20}
          className="mt-0.5 shrink-0 text-primary"
          aria-hidden="true"
        />

        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-text-primary">
            Purchase and goods receipt workflow
          </h3>

          <p className="text-xs leading-5 text-text-muted">
            A purchase order records the intended
            supplier transaction. Posting the purchase
            does not create stock. Received quantities,
            batch details, and inventory ledger
            movements are recorded separately through
            authorized goods receipts.
          </p>
        </div>
      </div>

      {dialogOpen && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          onMouseDown={(event) => {
            if (
              event.target ===
              event.currentTarget
            ) {
              closeDialog();
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="purchase-dialog-title"
            className="flex max-h-[95vh] w-full max-w-3xl flex-col overflow-hidden rounded-card bg-surface shadow-xl"
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="purchase-dialog-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  {dialogMode === "view"
                    ? "Purchase details"
                    : dialogMode === "edit"
                      ? "Edit purchase"
                      : "Add purchase"}
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  {dialogMode === "view"
                    ? "Review supplier purchase information."
                    : "Record supplier and material purchase details."}
                </p>
              </div>

              <button
                type="button"
                onClick={closeDialog}
                disabled={saving}
                aria-label="Close purchase dialog"
                className="rounded-control p-2 text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X
                  size={20}
                  aria-hidden="true"
                />
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
              {detailsLoading ? (
                <LoadingState
                  variant="section"
                  message="Loading purchase details..."
                />
              ) : detailsError ? (
                <div
                  role="alert"
                  className="app-alert app-alert-error flex items-start gap-3"
                >
                  <AlertCircle
                    size={19}
                    className="shrink-0"
                    aria-hidden="true"
                  />

                  <span>
                    {detailsError}
                  </span>
                </div>
              ) : dialogMode === "view" &&
                viewingPurchase ? (
                <PurchaseDetails
                  purchase={viewingPurchase}
                  suppliers={suppliers}
                  inventoryItems={inventoryItems}
                  onClose={closeDialog}
                />
              ) : dialogMode !== "view" &&
                (dialogMode === "create" ||
                  editingPurchase) ? (
                <PurchaseForm
                  key={
                    editingPurchase?.id ??
                    "new-purchase"
                  }
                  purchase={editingPurchase}
                  suppliers={suppliers}
                  inventoryItems={inventoryItems}
                  referencesLoading={
                    referencesLoading
                  }
                  referencesError={
                    referencesError
                  }
                  saving={saving}
                  error={formError}
                  onCancel={closeDialog}
                  onSubmit={handleSave}
                />
              ) : null}
            </div>
          </section>
        </div>
      )}

      <ConfirmDialog
        open={postingPurchase !== null}
        title="Post purchase order?"
        message={
          postingPurchase
            ? `Post purchase order ${postingPurchase.purchase_order_number}? The purchase will become a posted record. This action does not increase inventory; goods receipt posting is required separately.`
            : undefined
        }
        variant="warning"
        confirmLabel="Post purchase"
        isLoading={posting}
        onCancel={() => {
          if (!posting) {
            setPostingPurchase(null);
            setPostingError(null);
          }
        }}
        onConfirm={handlePostPurchase}
      >
        {postingError && (
          <p
            role="alert"
            className="mt-3 flex items-start gap-2 text-sm text-error"
          >
            <AlertCircle
              size={16}
              className="shrink-0"
              aria-hidden="true"
            />

            {postingError}
          </p>
        )}
      </ConfirmDialog>

      {!canManagePurchases && (
        <p className="text-xs text-text-muted">
          Purchase records are available in
          read-only mode for this account.
        </p>
      )}
    </div>
  );
}

export default PurchasesPage;