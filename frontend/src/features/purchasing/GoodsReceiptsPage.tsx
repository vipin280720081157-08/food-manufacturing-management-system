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
  ClipboardCheck,
  Eye,
  PackageCheck,
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
  UnitOfMeasure,
} from "../../types/business";

import { USER_ROLES } from "../../types/auth";
import { useAuth } from "../../hooks/useAuth";

import {
  apiClient,
  getApiErrorMessage,
} from "../../services/api/client";

import {
  getInventoryItems,
  getSuppliers,
} from "../../services/api/mastersApi";

import {
  DataTable,
  type DataTableColumn,
} from "../../components/tables/DataTable";

import { LoadingState } from "../../components/common/LoadingState";
import { StatusBadge } from "../../components/common/StatusBadge";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";

import {
  FormField,
  SelectField,
  TextareaField,
} from "../../components/forms/FormField";

import {
  formatDate,
  formatQuantity,
} from "../../utils/formatters";

const PAGE_SIZE = 20;
const REFERENCE_PAGE_SIZE = 100;

type ReceiptStatus = "draft" | "posted" | "cancelled";

interface PurchaseReferenceItem {
  id: UUID;
  item_id: UUID;
  quantity: string;
  unit: UnitOfMeasure;
  unit_price: string;
}

interface PurchaseReference {
  id: UUID;
  purchase_order_number: string;
  supplier_id: UUID;
  status: "draft" | "posted" | "cancelled";
  items?: PurchaseReferenceItem[];
}

interface GoodsReceiptItem {
  id: UUID;
  goods_receipt_id: UUID;
  purchase_order_item_id: UUID | null;
  item_id: UUID;
  received_quantity: string;
  accepted_quantity: string;
  rejected_quantity: string;
  unit: UnitOfMeasure;
  batch_number: string;
  expiry_date: string | null;
  remarks: string | null;
}

interface GoodsReceipt {
  id: UUID;
  goods_receipt_number: string;
  purchase_order_id: UUID;
  supplier_id: UUID;
  receipt_date: string;
  status: ReceiptStatus;
  remarks: string | null;
  items: GoodsReceiptItem[];
  created_at: string;
  updated_at: string | null;
}

interface GoodsReceiptSummary
  extends Omit<GoodsReceipt, "items"> {
  items?: GoodsReceiptItem[];
}

interface GoodsReceiptItemInput {
  purchase_order_item_id: UUID;
  item_id: UUID;
  received_quantity: string;
  accepted_quantity: string;
  rejected_quantity: string;
  unit: UnitOfMeasure;
  batch_number: string;
  expiry_date: string | null;
  remarks: string | null;
}

interface GoodsReceiptPayload {
  purchase_order_id: UUID;
  receipt_date: string;
  remarks: string | null;
  items: GoodsReceiptItemInput[];
}

interface EditableReceiptItem {
  localId: string;
  purchaseOrderItemId: string;
  receivedQuantity: string;
  acceptedQuantity: string;
  rejectedQuantity: string;
  batchNumber: string;
  expiryDate: string;
  remarks: string;
}

interface ReceiptFormValues {
  purchaseOrderId: string;
  receiptDate: string;
  remarks: string;
  items: EditableReceiptItem[];
}

interface ReceiptFormErrors {
  purchaseOrderId?: string;
  receiptDate?: string;
  items?: string;
  itemErrors: Record<string, string>;
}

interface ReceiptFormProps {
  receipt: GoodsReceipt | null;
  purchases: readonly PurchaseReference[];
  inventoryItems: readonly InventoryItem[];
  referencesLoading: boolean;
  referencesError: string | null;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (payload: GoodsReceiptPayload) => Promise<void>;
}

interface ReceiptDetailsProps {
  receipt: GoodsReceipt;
  purchases: readonly PurchaseReference[];
  suppliers: readonly Supplier[];
  inventoryItems: readonly InventoryItem[];
  onClose: () => void;
}

function todayISO(): string {
  const date = new Date();

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function normalizeDecimal(value: string): string {
  const trimmed = value.trim();

  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }

  const [whole = "0", fraction] = trimmed.split(".");
  const normalizedWhole =
    whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction?.replace(/0+$/, "");

  return normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
}

function parseQuantity(value: string): {
  integer: bigint;
  scale: number;
} | null {
  const normalized = normalizeDecimal(value);

  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return null;
  }

  const [whole = "0", fraction = ""] = normalized.split(".");

  if (whole.length + fraction.length > 30) {
    return null;
  }

  return {
    integer: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function compareQuantities(
  left: string,
  right: string,
): number | null {
  const a = parseQuantity(left);
  const b = parseQuantity(right);

  if (!a || !b) {
    return null;
  }

  const scale = Math.max(a.scale, b.scale);
  const leftValue =
    a.integer * 10n ** BigInt(scale - a.scale);
  const rightValue =
    b.integer * 10n ** BigInt(scale - b.scale);

  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;

  return 0;
}

function quantitiesReconcile(
  received: string,
  accepted: string,
  rejected: string,
): boolean {
  const a = parseQuantity(received);
  const b = parseQuantity(accepted);
  const c = parseQuantity(rejected);

  if (!a || !b || !c) {
    return false;
  }

  const scale = Math.max(a.scale, b.scale, c.scale);

  const receivedValue =
    a.integer * 10n ** BigInt(scale - a.scale);
  const acceptedValue =
    b.integer * 10n ** BigInt(scale - b.scale);
  const rejectedValue =
    c.integer * 10n ** BigInt(scale - c.scale);

  return receivedValue === acceptedValue + rejectedValue;
}

function createEditableItem(
  purchaseOrderItemId = "",
  receivedQuantity = "",
  acceptedQuantity = "",
  rejectedQuantity = "0",
  batchNumber = "",
  expiryDate = "",
  remarks = "",
): EditableReceiptItem {
  return {
    localId: crypto.randomUUID(),
    purchaseOrderItemId,
    receivedQuantity,
    acceptedQuantity,
    rejectedQuantity,
    batchNumber,
    expiryDate,
    remarks,
  };
}

function createEmptyForm(): ReceiptFormValues {
  return {
    purchaseOrderId: "",
    receiptDate: todayISO(),
    remarks: "",
    items: [createEditableItem()],
  };
}

function toFormValues(receipt: GoodsReceipt): ReceiptFormValues {
  return {
    purchaseOrderId: receipt.purchase_order_id,
    receiptDate: receipt.receipt_date,
    remarks: receipt.remarks ?? "",
    items:
      receipt.items.length > 0
        ? receipt.items.map((item) =>
            createEditableItem(
              item.purchase_order_item_id ?? "",
              item.received_quantity,
              item.accepted_quantity,
              item.rejected_quantity,
              item.batch_number,
              item.expiry_date ?? "",
              item.remarks ?? "",
            ),
          )
        : [createEditableItem()],
  };
}

function validateForm(
  values: ReceiptFormValues,
  purchases: readonly PurchaseReference[],
): ReceiptFormErrors {
  const errors: ReceiptFormErrors = {
    itemErrors: {},
  };

  const purchase = purchases.find(
    (entry) => entry.id === values.purchaseOrderId,
  );

  if (!purchase) {
    errors.purchaseOrderId =
      "Select a valid purchase order.";
  } else if (purchase.status !== "posted") {
    errors.purchaseOrderId =
      "Goods receipts must reference a posted purchase order.";
  }

  if (!isValidDate(values.receiptDate)) {
    errors.receiptDate =
      "Enter a valid receipt date.";
  }

  if (values.items.length === 0) {
    errors.items =
      "Add at least one received item.";
  }

  const purchaseItems = purchase?.items ?? [];
  const selectedIds = new Set<string>();

  for (const item of values.items) {
    const reference = purchaseItems.find(
      (entry) =>
        entry.id === item.purchaseOrderItemId,
    );

    if (!reference) {
      errors.itemErrors[item.localId] =
        "Select an item from the referenced purchase order.";
      continue;
    }

    if (selectedIds.has(reference.id)) {
      errors.itemErrors[item.localId] =
        "This purchase item is already included.";
      continue;
    }

    selectedIds.add(reference.id);

    if (
      compareQuantities(
        item.receivedQuantity,
        "0",
      ) !== 1
    ) {
      errors.itemErrors[item.localId] =
        "Received quantity must be greater than zero.";
      continue;
    }

    if (
      compareQuantities(
        item.acceptedQuantity,
        "0",
      ) === null ||
      compareQuantities(
        item.acceptedQuantity,
        "0",
      ) === -1
    ) {
      errors.itemErrors[item.localId] =
        "Accepted quantity must be a nonnegative number.";
      continue;
    }

    if (
      compareQuantities(
        item.rejectedQuantity,
        "0",
      ) === null ||
      compareQuantities(
        item.rejectedQuantity,
        "0",
      ) === -1
    ) {
      errors.itemErrors[item.localId] =
        "Rejected quantity must be a nonnegative number.";
      continue;
    }

    if (
      !quantitiesReconcile(
        item.receivedQuantity,
        item.acceptedQuantity,
        item.rejectedQuantity,
      )
    ) {
      errors.itemErrors[item.localId] =
        "Accepted and rejected quantities must equal the received quantity.";
      continue;
    }

    if (
      compareQuantities(
        item.acceptedQuantity,
        "0",
      ) === 1 &&
      !item.batchNumber.trim()
    ) {
      errors.itemErrors[item.localId] =
        "Batch number is required for accepted stock.";
      continue;
    }

    if (
      item.expiryDate &&
      !isValidDate(item.expiryDate)
    ) {
      errors.itemErrors[item.localId] =
        "Enter a valid expiry date.";
      continue;
    }

    if (
      item.expiryDate &&
      isValidDate(values.receiptDate) &&
      item.expiryDate < values.receiptDate
    ) {
      errors.itemErrors[item.localId] =
        "Expiry date cannot precede the receipt date.";
    }
  }

  return errors;
}

function hasValidationErrors(
  errors: ReceiptFormErrors,
): boolean {
  return Boolean(
    errors.purchaseOrderId ||
      errors.receiptDate ||
      errors.items ||
      Object.keys(errors.itemErrors).length > 0,
  );
}

function toPayload(
  values: ReceiptFormValues,
  purchases: readonly PurchaseReference[],
): GoodsReceiptPayload {
  const purchase = purchases.find(
    (entry) => entry.id === values.purchaseOrderId,
  );

  if (!purchase) {
    throw new Error(
      "The referenced purchase order is unavailable.",
    );
  }

  return {
    purchase_order_id: values.purchaseOrderId,
    receipt_date: values.receiptDate,
    remarks: values.remarks.trim() || null,
    items: values.items.map((item) => {
      const purchaseItem = purchase.items?.find(
        (entry) =>
          entry.id === item.purchaseOrderItemId,
      );

      if (!purchaseItem) {
        throw new Error(
          "A selected purchase item is unavailable.",
        );
      }

      return {
        purchase_order_item_id: purchaseItem.id,
        item_id: purchaseItem.item_id,
        received_quantity: normalizeDecimal(
          item.receivedQuantity,
        ),
        accepted_quantity: normalizeDecimal(
          item.acceptedQuantity,
        ),
        rejected_quantity: normalizeDecimal(
          item.rejectedQuantity,
        ),
        unit: purchaseItem.unit,
        batch_number: item.batchNumber.trim(),
        expiry_date: item.expiryDate || null,
        remarks: item.remarks.trim() || null,
      };
    }),
  };
}

async function fetchGoodsReceipts(
  page: number,
  search: string,
  signal?: AbortSignal,
): Promise<PaginatedResponse<GoodsReceiptSummary>> {
  return apiClient.get<
    PaginatedResponse<GoodsReceiptSummary>
  >("/goods-receipts", {
    query: {
      page,
      page_size: PAGE_SIZE,
      search: search || undefined,
    },
    signal,
  });
}

async function fetchGoodsReceipt(
  id: UUID,
  signal?: AbortSignal,
): Promise<GoodsReceipt> {
  return apiClient.get<GoodsReceipt>(
    `/goods-receipts/${encodeURIComponent(id)}`,
    { signal },
  );
}

async function fetchPurchaseReferences(
  signal?: AbortSignal,
): Promise<PurchaseReference[]> {
  const purchases: PurchaseReference[] = [];
  let page = 1;

  while (true) {
    const response = await apiClient.get<
      PaginatedResponse<PurchaseReference>
    >("/purchase-orders", {
      query: {
        page,
        page_size: REFERENCE_PAGE_SIZE,
      },
      signal,
    });

    purchases.push(...response.items);

    if (
      purchases.length >= response.total ||
      response.items.length === 0
    ) {
      break;
    }

    page += 1;
  }

  const postedPurchases = purchases.filter(
    (purchase) => purchase.status === "posted",
  );

  return Promise.all(
    postedPurchases.map((purchase) =>
      apiClient.get<PurchaseReference>(
        `/purchase-orders/${encodeURIComponent(
          purchase.id,
        )}`,
        { signal },
      ),
    ),
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

function ReceiptForm({
  receipt,
  purchases,
  inventoryItems,
  referencesLoading,
  referencesError,
  saving,
  error,
  onCancel,
  onSubmit,
}: ReceiptFormProps) {
  const [values, setValues] =
    useState<ReceiptFormValues>(() =>
      receipt
        ? toFormValues(receipt)
        : createEmptyForm(),
    );

  const [errors, setErrors] =
    useState<ReceiptFormErrors>({
      itemErrors: {},
    });

  const submittingRef = useRef(false);

  const selectedPurchase = useMemo(
    () =>
      purchases.find(
        (purchase) =>
          purchase.id === values.purchaseOrderId,
      ),
    [purchases, values.purchaseOrderId],
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

  const availablePurchases = useMemo(
    () =>
      purchases.filter(
        (purchase) =>
          purchase.status === "posted",
      ),
    [purchases],
  );

  const updateField = <
    K extends keyof ReceiptFormValues,
  >(
    field: K,
    value: ReceiptFormValues[K],
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

  const updatePurchase = (
    purchaseId: string,
  ): void => {
    setValues((current) => ({
      ...current,
      purchaseOrderId: purchaseId,
      items: [createEditableItem()],
    }));

    setErrors({
      itemErrors: {},
    });
  };

  const updateItem = (
    localId: string,
    field: keyof Omit<
      EditableReceiptItem,
      "localId"
    >,
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
      purchases,
    );

    setErrors(validationErrors);

    if (hasValidationErrors(validationErrors)) {
      return;
    }

    submittingRef.current = true;

    try {
      await onSubmit(
        toPayload(values, purchases),
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
          Receipt information
        </legend>

        <SelectField
          label="Purchase order"
          name="purchase_order_id"
          value={values.purchaseOrderId}
          options={availablePurchases.map(
            (purchase) => ({
              value: purchase.id,
              label:
                purchase.purchase_order_number,
            }),
          )}
          placeholder="Select posted purchase order"
          onChange={(event) =>
            updatePurchase(event.target.value)
          }
          error={errors.purchaseOrderId}
          required
          disabled={
            saving ||
            referencesLoading ||
            receipt !== null
          }
        />

        <FormField
          label="Receipt date"
          name="receipt_date"
          type="date"
          value={values.receiptDate}
          onChange={(event) =>
            updateField(
              "receiptDate",
              event.target.value,
            )
          }
          error={errors.receiptDate}
          required
          disabled={saving}
        />

        <TextareaField
          label="Receipt remarks"
          name="remarks"
          value={values.remarks}
          onChange={(event) =>
            updateField(
              "remarks",
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
          Received materials
        </legend>

        <p className="text-xs leading-5 text-text-muted">
          Record physical received quantities,
          accepted and rejected quantities, and
          batch information. Only accepted
          quantities increase available inventory
          after successful backend posting.
        </p>

        {referencesLoading && (
          <LoadingState
            variant="inline"
            message="Loading purchase references..."
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
          const selectedReference =
            selectedPurchase?.items?.find(
              (entry) =>
                entry.id ===
                item.purchaseOrderItemId,
            );

          const itemError =
            errors.itemErrors[item.localId];

          return (
            <div
              key={item.localId}
              className="space-y-4 rounded-control border border-border bg-background p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-text-primary">
                  Received item {index + 1}
                </h4>

                <button
                  type="button"
                  onClick={() =>
                    removeItem(item.localId)
                  }
                  disabled={saving}
                  aria-label={`Remove received item ${index + 1}`}
                  className="rounded-control px-2 py-1 text-xs font-medium text-error hover:bg-error/10 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                >
                  Remove
                </button>
              </div>

              <div>
                <label
                  htmlFor={`receipt-item-${item.localId}`}
                  className="app-field-label mb-2 block"
                >
                  Purchase item
                </label>

                <select
                  id={`receipt-item-${item.localId}`}
                  value={item.purchaseOrderItemId}
                  onChange={(event) =>
                    updateItem(
                      item.localId,
                      "purchaseOrderItemId",
                      event.target.value,
                    )
                  }
                  disabled={
                    saving ||
                    !selectedPurchase ||
                    referencesLoading
                  }
                  required
                  aria-invalid={Boolean(itemError)}
                  className="app-select w-full"
                >
                  <option value="">
                    Select purchase item
                  </option>

                  {selectedPurchase?.items?.map(
                    (purchaseItem) => {
                      const inventoryItem =
                        itemMap.get(
                          purchaseItem.item_id,
                        );

                      return (
                        <option
                          key={purchaseItem.id}
                          value={purchaseItem.id}
                        >
                          {inventoryItem?.name ??
                            purchaseItem.item_id}
                          {" — "}
                          {formatQuantity(
                            purchaseItem.quantity,
                          )}{" "}
                          {purchaseItem.unit} ordered
                        </option>
                      );
                    },
                  )}
                </select>
              </div>

              {selectedReference && (
                <p className="text-xs text-text-muted">
                  Purchase unit:{" "}
                  {selectedReference.unit}.
                  Accepted quantities and remaining
                  receivable quantities are validated
                  by the backend.
                </p>
              )}

              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label
                    htmlFor={`received-${item.localId}`}
                    className="app-field-label mb-2 block"
                  >
                    Received quantity
                  </label>

                  <input
                    id={`received-${item.localId}`}
                    type="text"
                    inputMode="decimal"
                    value={item.receivedQuantity}
                    onChange={(event) =>
                      updateItem(
                        item.localId,
                        "receivedQuantity",
                        event.target.value,
                      )
                    }
                    disabled={saving}
                    required
                    placeholder="0"
                    className="app-input w-full"
                  />
                </div>

                <div>
                  <label
                    htmlFor={`accepted-${item.localId}`}
                    className="app-field-label mb-2 block"
                  >
                    Accepted quantity
                  </label>

                  <input
                    id={`accepted-${item.localId}`}
                    type="text"
                    inputMode="decimal"
                    value={item.acceptedQuantity}
                    onChange={(event) =>
                      updateItem(
                        item.localId,
                        "acceptedQuantity",
                        event.target.value,
                      )
                    }
                    disabled={saving}
                    required
                    placeholder="0"
                    className="app-input w-full"
                  />
                </div>

                <div>
                  <label
                    htmlFor={`rejected-${item.localId}`}
                    className="app-field-label mb-2 block"
                  >
                    Rejected quantity
                  </label>

                  <input
                    id={`rejected-${item.localId}`}
                    type="text"
                    inputMode="decimal"
                    value={item.rejectedQuantity}
                    onChange={(event) =>
                      updateItem(
                        item.localId,
                        "rejectedQuantity",
                        event.target.value,
                      )
                    }
                    disabled={saving}
                    required
                    placeholder="0"
                    className="app-input w-full"
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor={`batch-${item.localId}`}
                    className="app-field-label mb-2 block"
                  >
                    Batch number
                  </label>

                  <input
                    id={`batch-${item.localId}`}
                    type="text"
                    value={item.batchNumber}
                    onChange={(event) =>
                      updateItem(
                        item.localId,
                        "batchNumber",
                        event.target.value,
                      )
                    }
                    disabled={saving}
                    maxLength={100}
                    className="app-input w-full"
                  />
                </div>

                <div>
                  <label
                    htmlFor={`expiry-${item.localId}`}
                    className="app-field-label mb-2 block"
                  >
                    Expiry date
                  </label>

                  <input
                    id={`expiry-${item.localId}`}
                    type="date"
                    value={item.expiryDate}
                    onChange={(event) =>
                      updateItem(
                        item.localId,
                        "expiryDate",
                        event.target.value,
                      )
                    }
                    disabled={saving}
                    className="app-input w-full"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor={`remarks-${item.localId}`}
                  className="app-field-label mb-2 block"
                >
                  Item remarks
                </label>

                <textarea
                  id={`remarks-${item.localId}`}
                  value={item.remarks}
                  onChange={(event) =>
                    updateItem(
                      item.localId,
                      "remarks",
                      event.target.value,
                    )
                  }
                  disabled={saving}
                  rows={2}
                  maxLength={1000}
                  className="app-textarea w-full"
                />
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
            !selectedPurchase ||
            referencesLoading ||
            Boolean(referencesError)
          }
          className="app-button app-button-secondary inline-flex items-center gap-2"
        >
          <Plus size={17} aria-hidden="true" />
          Add received item
        </button>
      </fieldset>

      <div className="rounded-control border border-border bg-background p-4">
        <p className="text-xs leading-5 text-text-muted">
          Saving creates or updates a draft goods
          receipt. Stock batches, inventory balances,
          weighted-average valuation, and stock
          movements are updated only when the
          backend successfully posts the receipt.
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
            : receipt
              ? "Save changes"
              : "Create goods receipt"}
        </button>
      </div>
    </form>
  );
}

function ReceiptDetails({
  receipt,
  purchases,
  suppliers,
  inventoryItems,
  onClose,
}: ReceiptDetailsProps) {
  const purchase = purchases.find(
    (entry) =>
      entry.id === receipt.purchase_order_id,
  );

  const supplier = suppliers.find(
    (entry) =>
      entry.id === receipt.supplier_id,
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
            Goods receipt number
          </dt>
          <dd className="mt-1 font-medium text-text-primary">
            {receipt.goods_receipt_number}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Status
          </dt>
          <dd className="mt-1">
            <StatusBadge
              status={receipt.status}
              category="transaction"
              showDot
            />
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Purchase order
          </dt>
          <dd className="mt-1 text-text-primary">
            {purchase?.purchase_order_number ??
              receipt.purchase_order_id}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Supplier
          </dt>
          <dd className="mt-1 text-text-primary">
            {supplier?.name ?? receipt.supplier_id}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Receipt date
          </dt>
          <dd className="mt-1 text-text-primary">
            {formatDate(receipt.receipt_date)}
          </dd>
        </div>
      </dl>

      <div className="border-t border-border pt-4">
        <h4 className="mb-3 text-sm font-semibold text-text-primary">
          Received items
        </h4>

        <div className="app-table-container">
          <table className="app-table">
            <thead>
              <tr>
                <th scope="col">Material</th>
                <th scope="col">Received</th>
                <th scope="col">Accepted</th>
                <th scope="col">Rejected</th>
                <th scope="col">Batch</th>
                <th scope="col">Expiry</th>
              </tr>
            </thead>

            <tbody>
              {receipt.items.map((item) => {
                const inventoryItem =
                  itemMap.get(item.item_id);

                return (
                  <tr key={item.id}>
                    <td>
                      {inventoryItem?.name ??
                        item.item_id}
                    </td>

                    <td className="app-numeric">
                      {formatQuantity(
                        item.received_quantity,
                      )}{" "}
                      {item.unit}
                    </td>

                    <td className="app-numeric">
                      {formatQuantity(
                        item.accepted_quantity,
                      )}{" "}
                      {item.unit}
                    </td>

                    <td className="app-numeric">
                      {formatQuantity(
                        item.rejected_quantity,
                      )}{" "}
                      {item.unit}
                    </td>

                    <td>
                      {item.batch_number || "—"}
                    </td>

                    <td>
                      {item.expiry_date
                        ? formatDate(
                            item.expiry_date,
                          )
                        : "—"}
                    </td>
                  </tr>
                );
              })}

              {receipt.items.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="py-6 text-center text-text-muted"
                  >
                    No receipt items recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {receipt.items.some((item) => item.remarks) && (
        <div className="space-y-3 border-t border-border pt-4">
          <h4 className="text-sm font-semibold text-text-primary">
            Item remarks
          </h4>

          {receipt.items
            .filter((item) => item.remarks)
            .map((item) => (
              <div
                key={item.id}
                className="rounded-control bg-background p-3"
              >
                <p className="text-xs font-semibold text-text-primary">
                  {itemMap.get(item.item_id)?.name ??
                    item.item_id}
                </p>

                <p className="mt-1 whitespace-pre-wrap text-sm text-text-muted">
                  {item.remarks}
                </p>
              </div>
            ))}
        </div>
      )}

      {receipt.remarks && (
        <div className="border-t border-border pt-4">
          <h4 className="text-sm font-semibold text-text-primary">
            Receipt remarks
          </h4>

          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-muted">
            {receipt.remarks}
          </p>
        </div>
      )}

      <div className="rounded-control border border-border bg-background p-4 text-xs leading-5 text-text-muted">
        {receipt.status === "posted"
          ? "This receipt has been posted. The backend is responsible for its accepted-stock movements, batch balances, and inventory valuation."
          : "This receipt has not posted inventory. Stock increases only after successful backend receipt posting."}
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

export function GoodsReceiptsPage() {
  const { user } = useAuth();

  const canRecordReceipts =
    user?.role === USER_ROLES.FACTORY_ADMIN ||
    user?.role === USER_ROLES.PRODUCTION_SUPERVISOR;

  const [receipts, setReceipts] =
    useState<GoodsReceiptSummary[]>([]);

  const [purchases, setPurchases] =
    useState<PurchaseReference[]>([]);

  const [suppliers, setSuppliers] =
    useState<Supplier[]>([]);

  const [inventoryItems, setInventoryItems] =
    useState<InventoryItem[]>([]);

  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [loading, setLoading] = useState(true);
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

  const [editingReceipt, setEditingReceipt] =
    useState<GoodsReceipt | null>(null);

  const [viewingReceipt, setViewingReceipt] =
    useState<GoodsReceipt | null>(null);

  const [saving, setSaving] = useState(false);

  const [formError, setFormError] =
    useState<string | null>(null);

  const [postingReceipt, setPostingReceipt] =
    useState<GoodsReceiptSummary | null>(null);

  const [posting, setPosting] = useState(false);

  const [postingError, setPostingError] =
    useState<string | null>(null);

  const detailsRequestRef = useRef(0);
  const saveRequestRef = useRef(false);
  const postRequestRef = useRef(false);

  const loadReceipts = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetchGoodsReceipts(
          page,
          search,
          signal,
        );

        if (signal?.aborted) {
          return;
        }

        setReceipts(response.items);
        setTotal(response.total);
      } catch (failure) {
        if (signal?.aborted) {
          return;
        }

        setError(getApiErrorMessage(failure));
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [page, search],
  );

  const loadReferences = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setReferencesLoading(true);
      setReferencesError(null);

      try {
        const [
          purchaseResults,
          supplierResults,
          itemResults,
        ] = await Promise.all([
          fetchPurchaseReferences(signal),
          fetchAllSuppliers(signal),
          fetchAllInventoryItems(signal),
        ]);

        if (signal?.aborted) {
          return;
        }

        setPurchases(purchaseResults);
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

    void loadReceipts(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadReceipts]);

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
    setEditingReceipt(null);
    setViewingReceipt(null);
    setDetailsLoading(false);
    setDetailsError(null);
    setFormError(null);
  };

  const openCreateDialog = (): void => {
    if (!canRecordReceipts) {
      return;
    }

    setDialogMode("create");
    setEditingReceipt(null);
    setViewingReceipt(null);
    setDetailsError(null);
    setFormError(null);
    setDialogOpen(true);
  };

  const openExistingReceipt = async (
    receipt: GoodsReceiptSummary,
    mode: "view" | "edit",
  ): Promise<void> => {
    if (
      mode === "edit" &&
      (!canRecordReceipts ||
        receipt.status !== "draft")
    ) {
      return;
    }

    const requestId =
      ++detailsRequestRef.current;

    setDialogMode(mode);
    setEditingReceipt(null);
    setViewingReceipt(null);
    setDetailsError(null);
    setFormError(null);
    setDetailsLoading(true);
    setDialogOpen(true);

    try {
      const details = await fetchGoodsReceipt(
        receipt.id,
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
          "Only draft goods receipts can be edited.",
        );
        return;
      }

      if (mode === "edit") {
        setEditingReceipt(details);
      } else {
        setViewingReceipt(details);
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
    payload: GoodsReceiptPayload,
  ): Promise<void> => {
    if (
      !canRecordReceipts ||
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
      if (editingReceipt) {
        await apiClient.put<GoodsReceipt>(
          `/goods-receipts/${encodeURIComponent(
            editingReceipt.id,
          )}`,
          payload,
        );

        setSuccessMessage(
          "Goods receipt updated successfully.",
        );
      } else {
        await apiClient.post<GoodsReceipt>(
          "/goods-receipts",
          payload,
        );

        setSuccessMessage(
          "Draft goods receipt created successfully. Inventory has not been updated.",
        );
      }

      detailsRequestRef.current += 1;

      setDialogOpen(false);
      setEditingReceipt(null);
      setViewingReceipt(null);

      await loadReceipts();
    } catch (failure) {
      setFormError(
        getApiErrorMessage(failure),
      );
    } finally {
      saveRequestRef.current = false;
      setSaving(false);
    }
  };

  const handlePostReceipt =
    async (): Promise<void> => {
      if (
        !postingReceipt ||
        !canRecordReceipts ||
        posting ||
        postRequestRef.current
      ) {
        return;
      }

      const receiptId = postingReceipt.id;

      postRequestRef.current = true;
      setPosting(true);
      setPostingError(null);
      setSuccessMessage(null);

      try {
        await apiClient.post<GoodsReceipt>(
          `/goods-receipts/${encodeURIComponent(
            receiptId,
          )}/post`,
          {},
        );

        setPostingReceipt(null);

        setSuccessMessage(
          "Goods receipt posted successfully. Accepted quantities and associated inventory movements have been processed by the backend.",
        );

        await loadReceipts();
      } catch (failure) {
        setPostingError(
          getApiErrorMessage(failure),
        );
      } finally {
        postRequestRef.current = false;
        setPosting(false);
      }
    };

  const purchaseMap = useMemo(
    () =>
      new Map(
        purchases.map((purchase) => [
          purchase.id,
          purchase,
        ]),
      ),
    [purchases],
  );

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
    DataTableColumn<GoodsReceiptSummary>[]
  >(
    () => [
      {
        key: "goods_receipt_number",
        header: "Goods receipt",
        accessor: "goods_receipt_number",
        render: (receipt) => (
          <span className="font-medium text-text-primary">
            {receipt.goods_receipt_number}
          </span>
        ),
      },
      {
        key: "purchase_order",
        header: "Purchase order",
        render: (receipt) =>
          purchaseMap.get(receipt.purchase_order_id)
            ?.purchase_order_number ??
          receipt.purchase_order_id,
      },
      {
        key: "supplier",
        header: "Supplier",
        render: (receipt) =>
          supplierMap.get(receipt.supplier_id)
            ?.name ?? receipt.supplier_id,
        hideOnMobile: true,
      },
      {
        key: "receipt_date",
        header: "Receipt date",
        render: (receipt) =>
          formatDate(receipt.receipt_date),
      },
      {
        key: "status",
        header: "Status",
        render: (receipt) => (
          <StatusBadge
            status={receipt.status}
            category="transaction"
            showDot
          />
        ),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (receipt) => (
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();

                void openExistingReceipt(
                  receipt,
                  "view",
                );
              }}
              className="app-button app-button-secondary inline-flex items-center gap-1.5"
              aria-label={`View goods receipt ${receipt.goods_receipt_number}`}
            >
              <Eye size={15} aria-hidden="true" />
              View
            </button>

            {canRecordReceipts &&
              receipt.status === "draft" && (
                <>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();

                      void openExistingReceipt(
                        receipt,
                        "edit",
                      );
                    }}
                    className="app-button app-button-secondary inline-flex items-center gap-1.5"
                    aria-label={`Edit goods receipt ${receipt.goods_receipt_number}`}
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
                      setPostingReceipt(receipt);
                    }}
                    className="app-button app-button-primary"
                    aria-label={`Post goods receipt ${receipt.goods_receipt_number}`}
                  >
                    Post
                  </button>
                </>
              )}
          </div>
        ),
      },
    ],
    [
      canRecordReceipts,
      purchaseMap,
      supplierMap,
    ],
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
            Goods Receipts
          </h2>

          <p className="app-page-description">
            Record received materials, accepted and
            rejected quantities, batch details, and
            authorized inventory receipts.
          </p>
        </div>

        {canRecordReceipts && (
          <button
            type="button"
            onClick={openCreateDialog}
            className="app-button app-button-primary inline-flex items-center justify-center gap-2"
          >
            <Plus
              size={18}
              aria-hidden="true"
            />

            Record goods receipt
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
              htmlFor="goods-receipt-search"
              className="app-sr-only"
            >
              Search goods receipts
            </label>

            <div className="relative min-w-0 flex-1">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />

              <input
                id="goods-receipt-search"
                type="search"
                value={searchInput}
                onChange={(event) =>
                  setSearchInput(
                    event.target.value,
                  )
                }
                placeholder="Search goods receipts..."
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
              void loadReceipts();
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

        {loading && receipts.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading goods receipts..."
          />
        ) : (
          <DataTable<GoodsReceiptSummary>
            columns={columns}
            data={receipts}
            getRowId={(receipt) =>
              receipt.id
            }
            loading={loading}
            error={error}
            onRetry={() => loadReceipts()}
            emptyMessage="No goods receipts found"
            emptyDescription={
              search
                ? "Try another search term."
                : "No goods receipt records are available."
            }
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="goods-receipts-table"
          />
        )}
      </section>

      <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
        <ClipboardCheck
          size={20}
          className="mt-0.5 shrink-0 text-primary"
          aria-hidden="true"
        />

        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-text-primary">
            Goods receipt posting
          </h3>

          <p className="text-xs leading-5 text-text-muted">
            Purchase recording and physical goods
            receipt posting are separate operations.
            Posting validates accepted quantities,
            creates or updates inventory batches,
            records stock-in movements, and updates
            moving weighted-average inventory
            valuation in a backend transaction.
            Duplicate posting must be rejected by
            the backend.
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
            aria-labelledby="goods-receipt-dialog-title"
            className="flex max-h-[95vh] w-full max-w-4xl flex-col overflow-hidden rounded-card bg-surface shadow-xl"
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="goods-receipt-dialog-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  {dialogMode === "view"
                    ? "Goods receipt details"
                    : dialogMode === "edit"
                      ? "Edit goods receipt"
                      : "Record goods receipt"}
                </h3>

                <p className="mt-1 text-sm text-text-muted">
                  {dialogMode === "view"
                    ? "Review physical receipt and batch information."
                    : "Record material acceptance and rejection details."}
                </p>
              </div>

              <button
                type="button"
                onClick={closeDialog}
                disabled={saving}
                aria-label="Close goods receipt dialog"
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
                  message="Loading goods receipt details..."
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

                  <span>{detailsError}</span>
                </div>
              ) : dialogMode === "view" &&
                viewingReceipt ? (
                <ReceiptDetails
                  receipt={viewingReceipt}
                  purchases={purchases}
                  suppliers={suppliers}
                  inventoryItems={inventoryItems}
                  onClose={closeDialog}
                />
              ) : dialogMode !== "view" &&
                (dialogMode === "create" ||
                  editingReceipt) ? (
                <ReceiptForm
                  key={
                    editingReceipt?.id ??
                    "new-goods-receipt"
                  }
                  receipt={editingReceipt}
                  purchases={purchases}
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
        open={postingReceipt !== null}
        title="Post goods receipt?"
        message={
          postingReceipt
            ? `Post goods receipt ${postingReceipt.goods_receipt_number}? The backend will validate the receipt and increase inventory only for accepted quantities. Posting may create stock batches, stock movements, and inventory valuation updates.`
            : undefined
        }
        variant="warning"
        confirmLabel="Post goods receipt"
        isLoading={posting}
        onCancel={() => {
          if (!posting) {
            setPostingReceipt(null);
            setPostingError(null);
          }
        }}
        onConfirm={handlePostReceipt}
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

      {!canRecordReceipts && (
        <p className="flex items-start gap-2 text-xs text-text-muted">
          <PackageCheck
            size={15}
            className="shrink-0"
            aria-hidden="true"
          />

          Goods receipt records are available in
          read-only mode for this account.
        </p>
      )}
    </div>
  );
}

export default GoodsReceiptsPage;