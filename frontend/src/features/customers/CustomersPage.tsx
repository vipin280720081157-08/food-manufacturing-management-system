import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import {
  AlertCircle,
  CheckCircle2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

import type {
  Address,
  Customer,
  PaginatedResponse,
} from "../../types/business";

import {
  USER_ROLES,
} from "../../types/auth";

import {
  useAuth,
} from "../../hooks/useAuth";

import {
  getCustomers,
  createCustomer,
  updateCustomer,
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

interface CustomerFormValues {
  customer_code: string;
  name: string;
  phone: string;
  email: string;
  gstin: string;
  assigned_salesman_id: string;
  is_active: boolean;
  billing_address: Address;
  shipping_address: Address;
}

type CustomerFormErrors = Partial<
  Record<
    | "customer_code"
    | "name"
    | "phone"
    | "email"
    | "gstin"
    | "assigned_salesman_id"
    | "billing_address"
    | "shipping_address",
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

function createEmptyForm(): CustomerFormValues {
  return {
    customer_code: "",
    name: "",
    phone: "",
    email: "",
    gstin: "",
    assigned_salesman_id: "",
    is_active: true,
    billing_address: { ...EMPTY_ADDRESS },
    shipping_address: { ...EMPTY_ADDRESS },
  };
}

function toFormValues(
  customer: Customer,
): CustomerFormValues {
  return {
    customer_code: customer.customer_code,
    name: customer.name,
    phone: customer.phone ?? "",
    email: customer.email ?? "",
    gstin: customer.gstin ?? "",
    assigned_salesman_id:
      customer.assigned_salesman_id,
    is_active: customer.is_active,
    billing_address: {
      ...customer.billing_address,
    },
    shipping_address: {
      ...customer.shipping_address,
    },
  };
}

function validateAddress(
  address: Address,
): boolean {
  return Boolean(
    address.line1.trim() &&
      address.city.trim() &&
      address.state.trim() &&
      address.postal_code.trim() &&
      address.country.trim(),
  );
}

function validateForm(
  values: CustomerFormValues,
): CustomerFormErrors {
  const errors: CustomerFormErrors = {};

  if (!values.customer_code.trim()) {
    errors.customer_code =
      "Customer code is required.";
  }

  if (!values.name.trim()) {
    errors.name =
      "Customer name is required.";
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

  if (!values.assigned_salesman_id.trim()) {
    errors.assigned_salesman_id =
      "An assigned salesman is required.";
  }

  if (!validateAddress(values.billing_address)) {
    errors.billing_address =
      "Complete all required billing address fields.";
  }

  if (!validateAddress(values.shipping_address)) {
    errors.shipping_address =
      "Complete all required shipping address fields.";
  }

  return errors;
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

function joinClasses(
  ...classes: Array<
    string | false | null | undefined
  >
): string {
  return classes.filter(Boolean).join(" ");
}

interface AddressFieldsProps {
  title: string;
  prefix: string;
  address: Address;
  disabled: boolean;
  error?: string;
  onChange: (
    field: keyof Address,
    value: string,
  ) => void;
}

function AddressFields({
  title,
  prefix,
  address,
  disabled,
  error,
  onChange,
}: AddressFieldsProps) {
  return (
    <fieldset className="space-y-4 rounded-card border border-border p-4">
      <legend className="px-2 text-sm font-semibold text-text-primary">
        {title}
      </legend>

      <FormField
        label="Address line 1"
        name={`${prefix}_line1`}
        value={address.line1}
        onChange={(event) =>
          onChange("line1", event.target.value)
        }
        required
        disabled={disabled}
        maxLength={200}
      />

      <FormField
        label="Address line 2"
        name={`${prefix}_line2`}
        value={address.line2 ?? ""}
        onChange={(event) =>
          onChange("line2", event.target.value)
        }
        disabled={disabled}
        maxLength={200}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="City"
          name={`${prefix}_city`}
          value={address.city}
          onChange={(event) =>
            onChange("city", event.target.value)
          }
          required
          disabled={disabled}
          maxLength={100}
        />

        <FormField
          label="State"
          name={`${prefix}_state`}
          value={address.state}
          onChange={(event) =>
            onChange("state", event.target.value)
          }
          required
          disabled={disabled}
          maxLength={100}
        />

        <FormField
          label="State code"
          name={`${prefix}_state_code`}
          value={address.state_code ?? ""}
          onChange={(event) =>
            onChange(
              "state_code",
              event.target.value,
            )
          }
          disabled={disabled}
          maxLength={10}
        />

        <FormField
          label="Postal code"
          name={`${prefix}_postal_code`}
          value={address.postal_code}
          onChange={(event) =>
            onChange(
              "postal_code",
              event.target.value,
            )
          }
          required
          disabled={disabled}
          maxLength={20}
        />
      </div>

      <FormField
        label="Country"
        name={`${prefix}_country`}
        value={address.country}
        onChange={(event) =>
          onChange("country", event.target.value)
        }
        required
        disabled={disabled}
        maxLength={100}
      />

      {error && (
        <p role="alert" className="app-field-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}

interface CustomerFormProps {
  initialCustomer: Customer | null;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (
    values: CustomerFormValues,
  ) => Promise<void>;
}

function CustomerForm({
  initialCustomer,
  saving,
  error,
  onCancel,
  onSubmit,
}: CustomerFormProps) {
  const [values, setValues] =
    useState<CustomerFormValues>(() =>
      initialCustomer
        ? toFormValues(initialCustomer)
        : createEmptyForm(),
    );

  const [errors, setErrors] =
    useState<CustomerFormErrors>({});

  const [sameShippingAddress, setSameShippingAddress] =
    useState(false);

  const updateField = <
    K extends keyof CustomerFormValues,
  >(
    key: K,
    value: CustomerFormValues[K],
  ): void => {
    setValues((current) => ({
      ...current,
      [key]: value,
    }));

    setErrors((current) => ({
      ...current,
      [key]: undefined,
    }));
  };

  const updateAddress = (
    kind: "billing_address" | "shipping_address",
    field: keyof Address,
    value: string,
  ): void => {
    setValues((current) => {
      const nextAddress = {
        ...current[kind],
        [field]: value,
      };

      if (
        kind === "billing_address" &&
        sameShippingAddress
      ) {
        return {
          ...current,
          billing_address: nextAddress,
          shipping_address: { ...nextAddress },
        };
      }

      return {
        ...current,
        [kind]: nextAddress,
      };
    });

    setErrors((current) => ({
      ...current,
      [kind]: undefined,
    }));
  };

  const handleSubmit = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();

    if (saving) {
      return;
    }

    const nextValues: CustomerFormValues = {
      ...values,
      customer_code:
        values.customer_code.trim(),
      name: values.name.trim(),
      phone: values.phone.trim(),
      email: values.email.trim(),
      gstin: values.gstin.trim().toUpperCase(),
      assigned_salesman_id:
        values.assigned_salesman_id.trim(),
      billing_address: normalizeAddress(
        values.billing_address,
      ),
      shipping_address: normalizeAddress(
        values.shipping_address,
      ),
    };

    const nextErrors = validateForm(nextValues);

    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    void onSubmit(nextValues);
  };

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="space-y-5"
      aria-busy={saving}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Customer code"
          name="customer_code"
          value={values.customer_code}
          onChange={(event) =>
            updateField(
              "customer_code",
              event.target.value,
            )
          }
          error={errors.customer_code}
          required
          disabled={saving || Boolean(initialCustomer)}
          maxLength={50}
        />

        <FormField
          label="Customer name"
          name="name"
          value={values.name}
          onChange={(event) =>
            updateField("name", event.target.value)
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
            updateField("phone", event.target.value)
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
            updateField("email", event.target.value)
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

        <FormField
          label="Assigned salesman ID"
          name="assigned_salesman_id"
          value={values.assigned_salesman_id}
          onChange={(event) =>
            updateField(
              "assigned_salesman_id",
              event.target.value,
            )
          }
          error={errors.assigned_salesman_id}
          helperText="Enter the identifier of an existing active salesman."
          required
          disabled={saving}
        />
      </div>

      <SelectField
        label="Customer status"
        name="is_active"
        value={values.is_active ? "active" : "inactive"}
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

      <AddressFields
        title="Billing address"
        prefix="billing"
        address={values.billing_address}
        disabled={saving}
        error={errors.billing_address}
        onChange={(field, value) =>
          updateAddress(
            "billing_address",
            field,
            value,
          )
        }
      />

      <label className="flex items-start gap-3 text-sm text-text-primary">
        <input
          type="checkbox"
          checked={sameShippingAddress}
          onChange={(event) => {
            const checked = event.target.checked;

            setSameShippingAddress(checked);

            if (checked) {
              setValues((current) => ({
                ...current,
                shipping_address: {
                  ...current.billing_address,
                },
              }));
            }
          }}
          disabled={saving}
          className="mt-0.5 h-4 w-4 accent-primary"
        />

        <span>
          Shipping address is the same as billing address
        </span>
      </label>

      {!sameShippingAddress && (
        <AddressFields
          title="Shipping address"
          prefix="shipping"
          address={values.shipping_address}
          disabled={saving}
          error={errors.shipping_address}
          onChange={(field, value) =>
            updateAddress(
              "shipping_address",
              field,
              value,
            )
          }
        />
      )}

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
            : initialCustomer
              ? "Save changes"
              : "Create customer"}
        </button>
      </div>
    </form>
  );
}

/**
 * Customer master management.
 * Customer visibility and mutation permissions are enforced by the API.
 */
export function CustomersPage() {
  const {
    user,
  } = useAuth();

  const canManageCustomers =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [customers, setCustomers] =
    useState<Customer[]>([]);

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

  const [editingCustomer, setEditingCustomer] =
    useState<Customer | null>(null);

  const [saving, setSaving] =
    useState(false);

  const [formError, setFormError] =
    useState<string | null>(null);

  const [statusCustomer, setStatusCustomer] =
    useState<Customer | null>(null);

  const [changingStatus, setChangingStatus] =
    useState(false);

  const [statusError, setStatusError] =
    useState<string | null>(null);

  const loadCustomers = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<void> => {
      setLoading(true);
      setError(null);

      try {
        const response: PaginatedResponse<Customer> =
          await getCustomers(
            {
              page,
              page_size: PAGE_SIZE,
              search: search || undefined,
            },
            {
              signal,
            },
          );

        if (signal?.aborted) {
          return;
        }

        setCustomers(response.items);
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

    void loadCustomers(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadCustomers]);

  const columns = useMemo<
    DataTableColumn<Customer>[]
  >(
    () => [
      {
        key: "customer_code",
        header: "Code",
        accessor: "customer_code",
        sortable: true,
      },
      {
        key: "name",
        header: "Customer",
        accessor: "name",
        sortable: true,
        render: (customer) => (
          <div className="min-w-44">
            <p className="font-medium text-text-primary">
              {customer.name}
            </p>

            {customer.email && (
              <p className="mt-1 text-xs text-text-muted">
                {customer.email}
              </p>
            )}
          </div>
        ),
      },
      {
        key: "phone",
        header: "Phone",
        accessor: "phone",
      },
      {
        key: "gstin",
        header: "GSTIN",
        accessor: "gstin",
        hideOnMobile: true,
      },
      {
        key: "billing_address",
        header: "Billing location",
        render: (customer) =>
          [
            customer.billing_address.city,
            customer.billing_address.state,
          ]
            .filter(Boolean)
            .join(", ") || "—",
        hideOnMobile: true,
      },
      {
        key: "is_active",
        header: "Status",
        render: (customer) => (
          <StatusBadge
            status={
              customer.is_active
                ? "active"
                : "inactive"
            }
            label={
              customer.is_active
                ? "Active"
                : "Inactive"
            }
            variant={
              customer.is_active
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
        render: (customer) => (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setEditingCustomer(customer);
                setFormError(null);
                setFormOpen(true);
              }}
              className="app-button app-button-secondary inline-flex items-center gap-1.5"
              aria-label={`View ${customer.name}`}
            >
              <Pencil
                size={15}
                aria-hidden="true"
              />

              {canManageCustomers
                ? "Edit"
                : "View"}
            </button>

            {canManageCustomers && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setStatusError(null);
                  setStatusCustomer(customer);
                }}
                className="app-button app-button-secondary"
              >
                {customer.is_active
                  ? "Deactivate"
                  : "Activate"}
              </button>
            )}
          </div>
        ),
      },
    ],
    [canManageCustomers],
  );

  const handleSearch = (
    event: FormEvent<HTMLFormElement>,
  ): void => {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  };

  const closeForm = (): void => {
    if (saving) {
      return;
    }

    setFormOpen(false);
    setEditingCustomer(null);
    setFormError(null);
  };

  const handleSave = async (
    values: CustomerFormValues,
  ): Promise<void> => {
    if (!canManageCustomers || saving) {
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
      assigned_salesman_id:
        values.assigned_salesman_id,
      billing_address: values.billing_address,
      shipping_address: values.shipping_address,
      is_active: values.is_active,
    };

    try {
      if (editingCustomer) {
        await updateCustomer(
          editingCustomer.id,
          payload,
        );

        setSuccessMessage(
          "Customer updated successfully.",
        );
      } else {
        await createCustomer({
          ...payload,
          customer_code: values.customer_code,
        });

        setSuccessMessage(
          "Customer created successfully.",
        );
      }

      setFormOpen(false);
      setEditingCustomer(null);

      await loadCustomers();
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
        !statusCustomer ||
        !canManageCustomers ||
        changingStatus
      ) {
        return;
      }

      setChangingStatus(true);
      setStatusError(null);
      setSuccessMessage(null);

      try {
        await updateCustomer(
          statusCustomer.id,
          {
            is_active:
              !statusCustomer.is_active,
          },
        );

        setSuccessMessage(
          statusCustomer.is_active
            ? "Customer deactivated successfully."
            : "Customer activated successfully.",
        );

        setStatusCustomer(null);

        await loadCustomers();
      } catch (failure) {
        setStatusError(
          getApiErrorMessage(failure),
        );
      } finally {
        setChangingStatus(false);
      }
    };

  return (
    <div className="app-page space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="app-page-title">
            Customers
          </h2>

          <p className="app-page-description">
            Manage customer details, billing
            addresses, shipping addresses,
            and salesman assignments.
          </p>
        </div>

        {canManageCustomers && (
          <button
            type="button"
            onClick={() => {
              setEditingCustomer(null);
              setFormError(null);
              setFormOpen(true);
            }}
            className="app-button app-button-primary inline-flex items-center justify-center gap-2"
          >
            <Plus
              size={18}
              aria-hidden="true"
            />

            Add customer
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
              htmlFor="customer-search"
              className="app-sr-only"
            >
              Search customers
            </label>

            <div className="relative min-w-0 flex-1">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />

              <input
                id="customer-search"
                type="search"
                value={searchInput}
                onChange={(event) =>
                  setSearchInput(
                    event.target.value,
                  )
                }
                placeholder="Search customers..."
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
              void loadCustomers();
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

        {loading && customers.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading customers..."
          />
        ) : (
          <DataTable<Customer>
            columns={columns}
            data={customers}
            getRowId={(customer) =>
              customer.id
            }
            loading={loading}
            error={error}
            onRetry={() => loadCustomers()}
            emptyMessage="No customers found"
            emptyDescription={
              search
                ? "Try another search term."
                : "No customer records are available."
            }
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="customers-table"
          />
        )}
      </section>

      {formOpen && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          onMouseDown={(event) => {
            if (
              event.target ===
              event.currentTarget
            ) {
              closeForm();
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="customer-form-title"
            className={joinClasses(
              "flex max-h-[95vh] w-full max-w-3xl flex-col",
              "overflow-hidden rounded-card bg-surface shadow-xl",
            )}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="customer-form-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  {editingCustomer
                    ? canManageCustomers
                      ? "Edit customer"
                      : "Customer details"
                    : "Add customer"}
                </h3>

                {editingCustomer && (
                  <p className="mt-1 text-sm text-text-muted">
                    {editingCustomer.customer_code}
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={closeForm}
                disabled={saving}
                aria-label="Close customer form"
                className="rounded-control p-2 text-text-muted hover:bg-background"
              >
                <X
                  size={20}
                  aria-hidden="true"
                />
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
              {!canManageCustomers &&
              editingCustomer ? (
                <div className="space-y-5 text-sm">
                  <dl className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <dt className="text-text-muted">
                        Customer name
                      </dt>
                      <dd className="mt-1 font-medium">
                        {editingCustomer.name}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Customer code
                      </dt>
                      <dd className="mt-1 font-medium">
                        {editingCustomer.customer_code}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Phone
                      </dt>
                      <dd className="mt-1">
                        {editingCustomer.phone ?? "—"}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Email
                      </dt>
                      <dd className="mt-1">
                        {editingCustomer.email ?? "—"}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        GSTIN
                      </dt>
                      <dd className="mt-1">
                        {editingCustomer.gstin ?? "—"}
                      </dd>
                    </div>

                    <div>
                      <dt className="text-text-muted">
                        Assigned salesman ID
                      </dt>
                      <dd className="mt-1 break-all">
                        {editingCustomer.assigned_salesman_id}
                      </dd>
                    </div>
                  </dl>

                  <div>
                    <h4 className="font-semibold">
                      Billing address
                    </h4>
                    <p className="mt-1 text-text-muted">
                      {formatAddress(
                        editingCustomer.billing_address,
                      )}
                    </p>
                  </div>

                  <div>
                    <h4 className="font-semibold">
                      Shipping address
                    </h4>
                    <p className="mt-1 text-text-muted">
                      {formatAddress(
                        editingCustomer.shipping_address,
                      )}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={closeForm}
                    className="app-button app-button-secondary"
                  >
                    Close
                  </button>
                </div>
              ) : (
                <CustomerForm
                  key={
                    editingCustomer?.id ??
                    "new-customer"
                  }
                  initialCustomer={editingCustomer}
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
        open={statusCustomer !== null}
        title={
          statusCustomer?.is_active
            ? "Deactivate customer?"
            : "Activate customer?"
        }
        message={
          statusCustomer?.is_active
            ? "The customer will become inactive. Existing transaction records will be preserved."
            : "The customer will become active again."
        }
        variant={
          statusCustomer?.is_active
            ? "warning"
            : "default"
        }
        confirmLabel={
          statusCustomer?.is_active
            ? "Deactivate"
            : "Activate"
        }
        isLoading={changingStatus}
        onCancel={() => {
          if (!changingStatus) {
            setStatusCustomer(null);
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
    </div>
  );
}

export default CustomersPage;
