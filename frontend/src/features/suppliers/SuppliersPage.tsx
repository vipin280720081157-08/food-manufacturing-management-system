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
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Truck,
  X,
} from "lucide-react";

import type {
  Address,
  Supplier,
} from "../../types/business";

import {
  USER_ROLES,
} from "../../types/auth";

import {
  useAuth,
} from "../../hooks/useAuth";

import {
  getSuppliers,
  createSupplier,
  updateSupplier,
} from "../../services/api/mastersApi";

import {
  getApiErrorMessage,
} from "../../services/api/client";

import {
  DataTable,
  type DataTableColumn,
} from "../../components/tables/DataTable";

import {
  StatusBadge,
} from "../../components/common/StatusBadge";

import {
  LoadingState,
} from "../../components/common/LoadingState";

import {
  ConfirmDialog,
} from "../../components/common/ConfirmDialog";

import {
  FormField,
  SelectField,
} from "../../components/forms/FormField";

const PAGE_SIZE = 20;

interface SupplierFormValues {
  supplier_code: string;
  name: string;
  phone: string;
  email: string;
  gstin: string;
  is_active: boolean;
  address: Address;
}

type SupplierFormErrors = Partial<
  Record<
    | "supplier_code"
    | "name"
    | "phone"
    | "email"
    | "gstin"
    | "address",
    string
  >
>;

const EMPTY_ADDRESS: Address = {
  line1: "",
  line2: "",
  city: "",
  state: "",
  state_code: "",
  postal_code: "",
  country: "India",
};

function createEmptyForm(): SupplierFormValues {
  return {
    supplier_code: "",
    name: "",
    phone: "",
    email: "",
    gstin: "",
    is_active: true,
    address: { ...EMPTY_ADDRESS },
  };
}

function toFormValues(
  supplier: Supplier,
): SupplierFormValues {
  return {
    supplier_code: supplier.supplier_code,
    name: supplier.name,
    phone: supplier.phone ?? "",
    email: supplier.email ?? "",
    gstin: supplier.gstin ?? "",
    is_active: supplier.is_active,
    address: { ...supplier.address },
  };
}

function normalizeAddress(
  address: Address,
): Address {
  return {
    line1: address.line1.trim(),
    line2: address.line2?.trim() || null,
    city: address.city.trim(),
    state: address.state.trim(),
    state_code:
      address.state_code?.trim() || null,
    postal_code: address.postal_code.trim(),
    country: address.country.trim(),
  };
}

function formatAddress(
  address: Address,
): string {
  return [
    address.line1,
    address.line2,
    address.city,
    address.state,
    address.postal_code,
    address.country,
  ]
    .filter(Boolean)
    .join(", ");
}

function validateForm(
  values: SupplierFormValues,
): SupplierFormErrors {
  const errors: SupplierFormErrors = {};

  if (!values.supplier_code.trim()) {
    errors.supplier_code =
      "Supplier code is required.";
  }

  if (!values.name.trim()) {
    errors.name =
      "Supplier name is required.";
  }

  if (
    values.phone.trim() &&
    !/^[+0-9()\-\s]{7,20}$/.test(
      values.phone.trim(),
    )
  ) {
    errors.phone =
      "Enter a valid phone number.";
  }

  if (
    values.email.trim() &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      values.email.trim(),
    )
  ) {
    errors.email =
      "Enter a valid email address.";
  }

  if (
    values.gstin.trim() &&
    !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(
      values.gstin.trim().toUpperCase(),
    )
  ) {
    errors.gstin =
      "Enter a valid 15-character GSTIN.";
  }

  const address = values.address;

  if (
    !address.line1.trim() ||
    !address.city.trim() ||
    !address.state.trim() ||
    !address.postal_code.trim() ||
    !address.country.trim()
  ) {
    errors.address =
      "Complete all required address fields.";
  }

  return errors;
}

function joinClasses(
  ...classes: Array<
    string | false | null | undefined
  >
): string {
  return classes.filter(Boolean).join(" ");
}

interface SupplierFormProps {
  supplier: Supplier | null;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (
    values: SupplierFormValues,
  ) => Promise<void>;
}

function SupplierForm({
  supplier,
  saving,
  error,
  onCancel,
  onSubmit,
}: SupplierFormProps) {
  const [values, setValues] =
    useState<SupplierFormValues>(() =>
      supplier
        ? toFormValues(supplier)
        : createEmptyForm(),
    );

  const [errors, setErrors] =
    useState<SupplierFormErrors>({});

  const submittingRef = useRef(false);

  const updateField = <
    K extends keyof SupplierFormValues,
  >(
    field: K,
    value: SupplierFormValues[K],
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

  const updateAddress = (
    field: keyof Address,
    value: string,
  ): void => {
    setValues((current) => ({
      ...current,
      address: {
        ...current.address,
        [field]: value,
      },
    }));

    setErrors((current) => ({
      ...current,
      address: undefined,
    }));
  };

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (saving || submittingRef.current) {
      return;
    }

    const normalized: SupplierFormValues = {
      ...values,
      supplier_code:
        values.supplier_code.trim(),
      name: values.name.trim(),
      phone: values.phone.trim(),
      email: values.email.trim(),
      gstin: values.gstin.trim().toUpperCase(),
      address: normalizeAddress(
        values.address,
      ),
    };

    const validationErrors =
      validateForm(normalized);

    setErrors(validationErrors);

    if (
      Object.keys(validationErrors).length > 0
    ) {
      return;
    }

    submittingRef.current = true;

    try {
      await onSubmit(normalized);
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
      className="space-y-5"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Supplier code"
          name="supplier_code"
          value={values.supplier_code}
          onChange={(event) =>
            updateField(
              "supplier_code",
              event.target.value,
            )
          }
          error={errors.supplier_code}
          required
          disabled={
            saving || supplier !== null
          }
          maxLength={50}
        />

        <FormField
          label="Supplier name"
          name="name"
          value={values.name}
          onChange={(event) =>
            updateField(
              "name",
              event.target.value,
            )
          }
          error={errors.name}
          required
          disabled={saving}
          maxLength={200}
        />

        <FormField
          label="Phone"
          name="phone"
          type="tel"
          value={values.phone}
          onChange={(event) =>
            updateField(
              "phone",
              event.target.value,
            )
          }
          error={errors.phone}
          disabled={saving}
          maxLength={30}
        />

        <FormField
          label="Email"
          name="email"
          type="email"
          value={values.email}
          onChange={(event) =>
            updateField(
              "email",
              event.target.value,
            )
          }
          error={errors.email}
          disabled={saving}
          maxLength={254}
        />

        <FormField
          label="GSTIN"
          name="gstin"
          value={values.gstin}
          onChange={(event) =>
            updateField(
              "gstin",
              event.target.value.toUpperCase(),
            )
          }
          error={errors.gstin}
          disabled={saving}
          maxLength={15}
          placeholder="15-character GSTIN"
        />

        <SelectField
          label="Supplier status"
          name="is_active"
          value={
            values.is_active
              ? "active"
              : "inactive"
          }
          options={[
            {
              value: "active",
              label: "Active",
            },
            {
              value: "inactive",
              label: "Inactive",
            },
          ]}
          onChange={(event) =>
            updateField(
              "is_active",
              event.target.value === "active",
            )
          }
          disabled={saving}
        />
      </div>

      <fieldset className="space-y-4 rounded-card border border-border p-4">
        <legend className="px-2 text-sm font-semibold text-text-primary">
          Supplier address
        </legend>

        <FormField
          label="Address line 1"
          name="address_line1"
          value={values.address.line1}
          onChange={(event) =>
            updateAddress(
              "line1",
              event.target.value,
            )
          }
          required
          disabled={saving}
          maxLength={200}
        />

        <FormField
          label="Address line 2"
          name="address_line2"
          value={values.address.line2 ?? ""}
          onChange={(event) =>
            updateAddress(
              "line2",
              event.target.value,
            )
          }
          disabled={saving}
          maxLength={200}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="City"
            name="address_city"
            value={values.address.city}
            onChange={(event) =>
              updateAddress(
                "city",
                event.target.value,
              )
            }
            required
            disabled={saving}
            maxLength={100}
          />

          <FormField
            label="State"
            name="address_state"
            value={values.address.state}
            onChange={(event) =>
              updateAddress(
                "state",
                event.target.value,
              )
            }
            required
            disabled={saving}
            maxLength={100}
          />

          <FormField
            label="State code"
            name="address_state_code"
            value={
              values.address.state_code ?? ""
            }
            onChange={(event) =>
              updateAddress(
                "state_code",
                event.target.value,
              )
            }
            disabled={saving}
            maxLength={10}
          />

          <FormField
            label="Postal code"
            name="address_postal_code"
            value={values.address.postal_code}
            onChange={(event) =>
              updateAddress(
                "postal_code",
                event.target.value,
              )
            }
            required
            disabled={saving}
            maxLength={20}
          />
        </div>

        <FormField
          label="Country"
          name="address_country"
          value={values.address.country}
          onChange={(event) =>
            updateAddress(
              "country",
              event.target.value,
            )
          }
          required
          disabled={saving}
          maxLength={100}
        />

        {errors.address && (
          <p
            role="alert"
            className="app-field-error"
          >
            {errors.address}
          </p>
        )}
      </fieldset>

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
          disabled={saving}
          className="app-button app-button-primary"
        >
          {saving
            ? "Saving..."
            : supplier
              ? "Save changes"
              : "Create supplier"}
        </button>
      </div>
    </form>
  );
}

interface SupplierDetailsProps {
  supplier: Supplier;
  onClose: () => void;
}

function SupplierDetails({
  supplier,
  onClose,
}: SupplierDetailsProps) {
  return (
    <div className="space-y-6">
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-text-muted">
            Supplier code
          </dt>
          <dd className="mt-1 font-medium text-text-primary">
            {supplier.supplier_code}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Supplier name
          </dt>
          <dd className="mt-1 font-medium text-text-primary">
            {supplier.name}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Phone
          </dt>
          <dd className="mt-1 text-text-primary">
            {supplier.phone || "—"}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Email
          </dt>
          <dd className="mt-1 break-all text-text-primary">
            {supplier.email || "—"}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            GSTIN
          </dt>
          <dd className="mt-1 text-text-primary">
            {supplier.gstin || "—"}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Status
          </dt>
          <dd className="mt-1">
            <StatusBadge
              status={
                supplier.is_active
                  ? "active"
                  : "inactive"
              }
              label={
                supplier.is_active
                  ? "Active"
                  : "Inactive"
              }
              variant={
                supplier.is_active
                  ? "success"
                  : "neutral"
              }
              showDot
            />
          </dd>
        </div>
      </dl>

      <div className="border-t border-border pt-4">
        <h4 className="text-sm font-semibold text-text-primary">
          Supplier address
        </h4>

        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-muted">
          {formatAddress(supplier.address)}
        </p>
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

/**
 * Supplier master management.
 * All mutations are submitted to the backend for authorization
 * and validation.
 */
export function SuppliersPage() {
  const { user } = useAuth();

  const canManageSuppliers =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [suppliers, setSuppliers] =
    useState<Supplier[]>([]);

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

  const [error, setError] =
    useState<string | null>(null);

  const [successMessage, setSuccessMessage] =
    useState<string | null>(null);

  const [formOpen, setFormOpen] =
    useState(false);

  const [editingSupplier, setEditingSupplier] =
    useState<Supplier | null>(null);

  const [viewingSupplier, setViewingSupplier] =
    useState<Supplier | null>(null);

  const [saving, setSaving] =
    useState(false);

  const [formError, setFormError] =
    useState<string | null>(null);

  const [statusSupplier, setStatusSupplier] =
    useState<Supplier | null>(null);

  const [changingStatus, setChangingStatus] =
    useState(false);

  const [statusError, setStatusError] =
    useState<string | null>(null);

  const loadSuppliers = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<void> => {
      setLoading(true);
      setError(null);

      try {
        const response = await getSuppliers(
          {
            page,
            page_size: PAGE_SIZE,
            search: search || undefined,
          },
          { signal },
        );

        if (signal?.aborted) {
          return;
        }

        setSuppliers(response.items);
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

  useEffect(() => {
    const controller = new AbortController();

    void loadSuppliers(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadSuppliers]);

  const closeForm = (): void => {
    if (saving) {
      return;
    }

    setFormOpen(false);
    setEditingSupplier(null);
    setFormError(null);
  };

  const openCreateForm = (): void => {
    if (!canManageSuppliers) {
      return;
    }

    setEditingSupplier(null);
    setFormError(null);
    setFormOpen(true);
  };

  const openEditForm = (
    supplier: Supplier,
  ): void => {
    if (!canManageSuppliers) {
      return;
    }

    setEditingSupplier(supplier);
    setFormError(null);
    setFormOpen(true);
  };

  const handleSave = async (
    values: SupplierFormValues,
  ): Promise<void> => {
    if (!canManageSuppliers || saving) {
      return;
    }

    setSaving(true);
    setFormError(null);
    setSuccessMessage(null);

    const payload = {
      name: values.name,
      phone: values.phone || null,
      email: values.email || null,
      gstin: values.gstin || null,
      address: values.address,
      is_active: values.is_active,
    };

    try {
      if (editingSupplier) {
        await updateSupplier(
          editingSupplier.id,
          payload,
        );

        setSuccessMessage(
          "Supplier updated successfully.",
        );
      } else {
        await createSupplier({
          ...payload,
          supplier_code:
            values.supplier_code,
        });

        setSuccessMessage(
          "Supplier created successfully.",
        );
      }

      setFormOpen(false);
      setEditingSupplier(null);

      await loadSuppliers();
    } catch (failure) {
      setFormError(
        getApiErrorMessage(failure),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange =
    async (): Promise<void> => {
      if (
        !statusSupplier ||
        !canManageSuppliers ||
        changingStatus
      ) {
        return;
      }

      setChangingStatus(true);
      setStatusError(null);
      setSuccessMessage(null);

      try {
        await updateSupplier(
          statusSupplier.id,
          {
            is_active:
              !statusSupplier.is_active,
          },
        );

        setSuccessMessage(
          statusSupplier.is_active
            ? "Supplier deactivated successfully."
            : "Supplier activated successfully.",
        );

        setStatusSupplier(null);

        await loadSuppliers();
      } catch (failure) {
        setStatusError(
          getApiErrorMessage(failure),
        );
      } finally {
        setChangingStatus(false);
      }
    };

  const columns = useMemo<
    DataTableColumn<Supplier>[]
  >(
    () => [
      {
        key: "supplier_code",
        header: "Code",
        accessor: "supplier_code",
        sortable: true,
      },
      {
        key: "name",
        header: "Supplier",
        accessor: "name",
        sortable: true,
        render: (supplier) => (
          <div className="min-w-40">
            <p className="font-medium text-text-primary">
              {supplier.name}
            </p>

            {supplier.email && (
              <p className="mt-1 text-xs text-text-muted">
                {supplier.email}
              </p>
            )}
          </div>
        ),
      },
      {
        key: "phone",
        header: "Phone",
        render: (supplier) =>
          supplier.phone || "—",
      },
      {
        key: "gstin",
        header: "GSTIN",
        render: (supplier) =>
          supplier.gstin || "—",
        hideOnMobile: true,
      },
      {
        key: "location",
        header: "Location",
        render: (supplier) =>
          [
            supplier.address.city,
            supplier.address.state,
          ]
            .filter(Boolean)
            .join(", ") || "—",
        hideOnMobile: true,
      },
      {
        key: "is_active",
        header: "Status",
        render: (supplier) => (
          <StatusBadge
            status={
              supplier.is_active
                ? "active"
                : "inactive"
            }
            label={
              supplier.is_active
                ? "Active"
                : "Inactive"
            }
            variant={
              supplier.is_active
                ? "success"
                : "neutral"
            }
            showDot
          />
        ),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (supplier) => (
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setViewingSupplier(supplier);
              }}
              className="app-button app-button-secondary inline-flex items-center gap-1.5"
              aria-label={`View ${supplier.name}`}
            >
              <Eye
                size={15}
                aria-hidden="true"
              />

              View
            </button>

            {canManageSuppliers && (
              <>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    openEditForm(supplier);
                  }}
                  className="app-button app-button-secondary inline-flex items-center gap-1.5"
                  aria-label={`Edit ${supplier.name}`}
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
                    setStatusError(null);
                    setStatusSupplier(supplier);
                  }}
                  className="app-button app-button-secondary"
                  aria-label={
                    supplier.is_active
                      ? `Deactivate ${supplier.name}`
                      : `Activate ${supplier.name}`
                  }
                >
                  {supplier.is_active
                    ? "Deactivate"
                    : "Activate"}
                </button>
              </>
            )}
          </div>
        ),
      },
    ],
    [canManageSuppliers],
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
            Suppliers
          </h2>

          <p className="app-page-description">
            Maintain supplier details, tax
            registration information, addresses,
            and active status.
          </p>
        </div>

        {canManageSuppliers && (
          <button
            type="button"
            onClick={openCreateForm}
            className="app-button app-button-primary inline-flex items-center justify-center gap-2"
          >
            <Plus
              size={18}
              aria-hidden="true"
            />

            Add supplier
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
              htmlFor="supplier-search"
              className="app-sr-only"
            >
              Search suppliers
            </label>

            <div className="relative min-w-0 flex-1">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />

              <input
                id="supplier-search"
                type="search"
                value={searchInput}
                onChange={(event) =>
                  setSearchInput(
                    event.target.value,
                  )
                }
                placeholder="Search suppliers..."
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
              void loadSuppliers();
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

        {loading && suppliers.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading suppliers..."
          />
        ) : (
          <DataTable<Supplier>
            columns={columns}
            data={suppliers}
            getRowId={(supplier) =>
              supplier.id
            }
            loading={loading}
            error={error}
            onRetry={() => loadSuppliers()}
            emptyMessage="No suppliers found"
            emptyDescription={
              search
                ? "Try another search term."
                : "No supplier records are available."
            }
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="suppliers-table"
          />
        )}
      </section>

      {(formOpen || viewingSupplier) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (
              event.target !==
              event.currentTarget
            ) {
              return;
            }

            if (viewingSupplier) {
              setViewingSupplier(null);
            } else {
              closeForm();
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="supplier-dialog-title"
            className={joinClasses(
              "flex max-h-[95vh] w-full max-w-3xl flex-col",
              "overflow-hidden rounded-card bg-surface shadow-xl",
            )}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="supplier-dialog-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  {viewingSupplier
                    ? "Supplier details"
                    : editingSupplier
                      ? "Edit supplier"
                      : "Add supplier"}
                </h3>

                {(viewingSupplier ||
                  editingSupplier) && (
                  <p className="mt-1 text-sm text-text-muted">
                    {(
                      viewingSupplier ??
                      editingSupplier
                    )?.supplier_code}
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  if (viewingSupplier) {
                    setViewingSupplier(null);
                  } else {
                    closeForm();
                  }
                }}
                disabled={saving}
                aria-label="Close supplier dialog"
                className="rounded-control p-2 text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X
                  size={20}
                  aria-hidden="true"
                />
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
              {viewingSupplier ? (
                <SupplierDetails
                  supplier={viewingSupplier}
                  onClose={() =>
                    setViewingSupplier(null)
                  }
                />
              ) : (
                <SupplierForm
                  key={
                    editingSupplier?.id ??
                    "new-supplier"
                  }
                  supplier={editingSupplier}
                  saving={saving}
                  error={formError}
                  onCancel={closeForm}
                  onSubmit={handleSave}
                />
              )}
            </div>
          </section>
        </div>
      )}

      <ConfirmDialog
        open={statusSupplier !== null}
        title={
          statusSupplier?.is_active
            ? "Deactivate supplier?"
            : "Activate supplier?"
        }
        message={
          statusSupplier?.is_active
            ? "The supplier will become inactive. Existing purchasing and inventory records will be preserved."
            : "The supplier will become active again."
        }
        variant={
          statusSupplier?.is_active
            ? "warning"
            : "default"
        }
        confirmLabel={
          statusSupplier?.is_active
            ? "Deactivate"
            : "Activate"
        }
        isLoading={changingStatus}
        onCancel={() => {
          if (!changingStatus) {
            setStatusSupplier(null);
            setStatusError(null);
          }
        }}
        onConfirm={handleStatusChange}
      >
        {statusError && (
          <p
            role="alert"
            className="mt-3 flex items-start gap-2 text-sm text-error"
          >
            <AlertCircle
              size={16}
              className="shrink-0"
              aria-hidden="true"
            />

            {statusError}
          </p>
        )}
      </ConfirmDialog>

      {!canManageSuppliers && (
        <p className="flex items-start gap-2 text-xs text-text-muted">
          <Truck
            size={15}
            className="shrink-0"
            aria-hidden="true"
          />

          Supplier information is available in
          read-only mode for this account.
        </p>
      )}
    </div>
  );
}

export default SuppliersPage;