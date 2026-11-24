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
  EyeOff,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRound,
  Users,
  X,
} from "lucide-react";

import type {
  CreateUserRequest,
  UpdateUserRequest,
  UserAccount,
  UserRole,
} from "../../types/auth";

import {
  ALL_USER_ROLES,
  USER_ROLE_LABELS,
  USER_ROLES,
} from "../../types/auth";

import {
  useAuth,
} from "../../hooks/useAuth";

import {
  createUser,
  getUsers,
  setUserActiveStatus,
  updateUser,
} from "../../services/api/authApi";

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

import {
  formatDateTime,
} from "../../utils/formatters";

const PAGE_SIZE = 20;

const USERNAME_PATTERN =
  /^[A-Za-z0-9._-]+$/;

interface UserFormValues {
  username: string;
  full_name: string;
  password: string;
  confirm_password: string;
  role: UserRole;
  is_active: boolean;
}

type UserFormErrors = Partial<
  Record<keyof UserFormValues, string>
>;

interface UserFormProps {
  initialUser: UserAccount | null;
  currentUserId: string | null;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (
    values: UserFormValues,
  ) => Promise<void>;
}

interface UserDetailsProps {
  account: UserAccount;
  onClose: () => void;
}

function joinClasses(
  ...classes: Array<
    string | false | null | undefined
  >
): string {
  return classes.filter(Boolean).join(" ");
}

function createEmptyForm(): UserFormValues {
  return {
    username: "",
    full_name: "",
    password: "",
    confirm_password: "",
    role: USER_ROLES.SALESMAN,
    is_active: true,
  };
}

function toFormValues(
  account: UserAccount,
): UserFormValues {
  return {
    username: account.username,
    full_name: account.full_name,
    password: "",
    confirm_password: "",
    role: account.role,
    is_active: account.is_active,
  };
}

function validateForm(
  values: UserFormValues,
  isEditing: boolean,
): UserFormErrors {
  const errors: UserFormErrors = {};

  if (!values.username.trim()) {
    errors.username =
      "Username is required.";
  } else if (
    !USERNAME_PATTERN.test(
      values.username.trim(),
    )
  ) {
    errors.username =
      "Use letters, numbers, periods, underscores, or hyphens.";
  }

  if (!values.full_name.trim()) {
    errors.full_name =
      "Full name is required.";
  }

  if (
    !ALL_USER_ROLES.includes(values.role)
  ) {
    errors.role =
      "Select a valid user role.";
  }

  if (!isEditing) {
    if (!values.password) {
      errors.password =
        "Password is required.";
    } else if (
      values.password.length < 8
    ) {
      errors.password =
        "Password must contain at least 8 characters.";
    }

    if (!values.confirm_password) {
      errors.confirm_password =
        "Confirm the password.";
    } else if (
      values.password !==
      values.confirm_password
    ) {
      errors.confirm_password =
        "Passwords do not match.";
    }
  }

  return errors;
}

function UserForm({
  initialUser,
  currentUserId,
  saving,
  error,
  onCancel,
  onSubmit,
}: UserFormProps) {
  const [values, setValues] =
    useState<UserFormValues>(() =>
      initialUser
        ? toFormValues(initialUser)
        : createEmptyForm(),
    );

  const [errors, setErrors] =
    useState<UserFormErrors>({});

  const [showPassword, setShowPassword] =
    useState(false);

  const [showConfirmPassword, setShowConfirmPassword] =
    useState(false);

  const submittingRef = useRef(false);

  const isEditing = initialUser !== null;

  const isCurrentAccount =
    initialUser?.id === currentUserId;

  const updateField = <
    K extends keyof UserFormValues,
  >(
    field: K,
    value: UserFormValues[K],
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

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (saving || submittingRef.current) {
      return;
    }

    const normalized: UserFormValues = {
      ...values,
      username: values.username.trim(),
      full_name: values.full_name.trim(),
    };

    const validationErrors =
      validateForm(
        normalized,
        isEditing,
      );

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
          label="Username"
          name="username"
          value={values.username}
          onChange={(event) =>
            updateField(
              "username",
              event.target.value,
            )
          }
          error={errors.username}
          helperText={
            isEditing
              ? "Username cannot be changed."
              : "Letters, numbers, periods, underscores, and hyphens."
          }
          required
          disabled={saving || isEditing}
          maxLength={100}
          autoComplete="off"
        />

        <FormField
          label="Full name"
          name="full_name"
          value={values.full_name}
          onChange={(event) =>
            updateField(
              "full_name",
              event.target.value,
            )
          }
          error={errors.full_name}
          required
          disabled={saving}
          maxLength={200}
          autoComplete="name"
        />
      </div>

      {!isEditing && (
        <fieldset className="space-y-4 rounded-card border border-border p-4">
          <legend className="px-2 text-sm font-semibold text-text-primary">
            Initial account password
          </legend>

          <div>
            <label
              htmlFor="new-user-password"
              className="app-field-label mb-2 block"
            >
              Password
            </label>

            <div className="relative">
              <input
                id="new-user-password"
                name="password"
                type={
                  showPassword
                    ? "text"
                    : "password"
                }
                value={values.password}
                onChange={(event) =>
                  updateField(
                    "password",
                    event.target.value,
                  )
                }
                autoComplete="new-password"
                required
                disabled={saving}
                minLength={8}
                aria-invalid={
                  Boolean(errors.password)
                }
                aria-describedby={
                  errors.password
                    ? "new-user-password-error"
                    : undefined
                }
                className="app-input w-full pr-12"
              />

              <button
                type="button"
                onClick={() =>
                  setShowPassword(
                    (current) => !current,
                  )
                }
                disabled={saving}
                aria-label={
                  showPassword
                    ? "Hide password"
                    : "Show password"
                }
                aria-pressed={showPassword}
                className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-control text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                {showPassword ? (
                  <EyeOff
                    size={18}
                    aria-hidden="true"
                  />
                ) : (
                  <Eye
                    size={18}
                    aria-hidden="true"
                  />
                )}
              </button>
            </div>

            {errors.password && (
              <p
                id="new-user-password-error"
                role="alert"
                className="app-field-error mt-1"
              >
                {errors.password}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="new-user-confirm-password"
              className="app-field-label mb-2 block"
            >
              Confirm password
            </label>

            <div className="relative">
              <input
                id="new-user-confirm-password"
                name="confirm_password"
                type={
                  showConfirmPassword
                    ? "text"
                    : "password"
                }
                value={
                  values.confirm_password
                }
                onChange={(event) =>
                  updateField(
                    "confirm_password",
                    event.target.value,
                  )
                }
                autoComplete="new-password"
                required
                disabled={saving}
                aria-invalid={
                  Boolean(
                    errors.confirm_password,
                  )
                }
                aria-describedby={
                  errors.confirm_password
                    ? "new-user-confirm-password-error"
                    : undefined
                }
                className="app-input w-full pr-12"
              />

              <button
                type="button"
                onClick={() =>
                  setShowConfirmPassword(
                    (current) => !current,
                  )
                }
                disabled={saving}
                aria-label={
                  showConfirmPassword
                    ? "Hide confirmation password"
                    : "Show confirmation password"
                }
                aria-pressed={
                  showConfirmPassword
                }
                className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-control text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                {showConfirmPassword ? (
                  <EyeOff
                    size={18}
                    aria-hidden="true"
                  />
                ) : (
                  <Eye
                    size={18}
                    aria-hidden="true"
                  />
                )}
              </button>
            </div>

            {errors.confirm_password && (
              <p
                id="new-user-confirm-password-error"
                role="alert"
                className="app-field-error mt-1"
              >
                {errors.confirm_password}
              </p>
            )}
          </div>

          <p className="text-xs leading-5 text-text-muted">
            Passwords are submitted directly
            to the authentication API and are
            not stored in browser storage.
          </p>
        </fieldset>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Assigned role"
          name="role"
          value={values.role}
          options={ALL_USER_ROLES.map(
            (role) => ({
              value: role,
              label: USER_ROLE_LABELS[role],
            }),
          )}
          onChange={(event) =>
            updateField(
              "role",
              event.target.value as UserRole,
            )
          }
          error={errors.role}
          required
          disabled={
            saving || isCurrentAccount
          }
          helperText={
            isCurrentAccount
              ? "The current account cannot change its own role here."
              : "Role permissions are enforced by the backend."
          }
        />

        <SelectField
          label="Account status"
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
          disabled={
            saving || isCurrentAccount
          }
          helperText={
            isCurrentAccount
              ? "The current account cannot deactivate itself here."
              : "Inactive accounts cannot sign in."
          }
        />
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
          disabled={saving}
          className="app-button app-button-primary"
        >
          {saving
            ? "Saving..."
            : isEditing
              ? "Save changes"
              : "Create user"}
        </button>
      </div>
    </form>
  );
}

function UserDetails({
  account,
  onClose,
}: UserDetailsProps) {
  return (
    <div className="space-y-6">
      <dl className="grid gap-5 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-text-muted">
            Username
          </dt>

          <dd className="mt-1 font-medium text-text-primary">
            {account.username}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Full name
          </dt>

          <dd className="mt-1 font-medium text-text-primary">
            {account.full_name}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Assigned role
          </dt>

          <dd className="mt-1 text-text-primary">
            {USER_ROLE_LABELS[account.role]}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Account status
          </dt>

          <dd className="mt-1">
            <StatusBadge
              status={
                account.is_active
                  ? "active"
                  : "inactive"
              }
              label={
                account.is_active
                  ? "Active"
                  : "Inactive"
              }
              variant={
                account.is_active
                  ? "success"
                  : "neutral"
              }
              showDot
            />
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Created
          </dt>

          <dd className="mt-1 text-text-primary">
            {formatDateTime(
              account.created_at,
            )}
          </dd>
        </div>

        <div>
          <dt className="text-text-muted">
            Last updated
          </dt>

          <dd className="mt-1 text-text-primary">
            {account.updated_at
              ? formatDateTime(
                  account.updated_at,
                )
              : "—"}
          </dd>
        </div>

        <div className="sm:col-span-2">
          <dt className="text-text-muted">
            User ID
          </dt>

          <dd className="mt-1 break-all font-mono text-xs text-text-primary">
            {account.id}
          </dd>
        </div>
      </dl>

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
 * User account management.
 * Authentication, role assignment, and account state
 * changes remain authoritative on the backend.
 */
export function UsersPage() {
  const {
    user,
    refreshUser,
  } = useAuth();

  const canManageUsers =
    user?.role === USER_ROLES.FACTORY_ADMIN;

  const [accounts, setAccounts] =
    useState<UserAccount[]>([]);

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

  const [editingUser, setEditingUser] =
    useState<UserAccount | null>(null);

  const [viewingUser, setViewingUser] =
    useState<UserAccount | null>(null);

  const [saving, setSaving] =
    useState(false);

  const [formError, setFormError] =
    useState<string | null>(null);

  const [statusUser, setStatusUser] =
    useState<UserAccount | null>(null);

  const [changingStatus, setChangingStatus] =
    useState(false);

  const [statusError, setStatusError] =
    useState<string | null>(null);

  const loadUsers = useCallback(
    async (
      signal?: AbortSignal,
    ): Promise<void> => {
      setLoading(true);
      setError(null);

      try {
        const response = await getUsers(
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

        setAccounts(response.items);
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

    void loadUsers(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadUsers]);

  const closeForm = (): void => {
    if (saving) {
      return;
    }

    setFormOpen(false);
    setEditingUser(null);
    setFormError(null);
  };

  const openCreateForm = (): void => {
    if (!canManageUsers) {
      return;
    }

    setEditingUser(null);
    setFormError(null);
    setFormOpen(true);
  };

  const openEditForm = (
    account: UserAccount,
  ): void => {
    if (!canManageUsers) {
      return;
    }

    setEditingUser(account);
    setFormError(null);
    setFormOpen(true);
  };

  const handleSave = async (
    values: UserFormValues,
  ): Promise<void> => {
    if (!canManageUsers || saving) {
      return;
    }

    setSaving(true);
    setFormError(null);
    setSuccessMessage(null);

    try {
      if (editingUser) {
        const isCurrentAccount =
          editingUser.id === user?.id;

        const payload: UpdateUserRequest = {
          full_name: values.full_name,
        };

        if (!isCurrentAccount) {
          payload.role = values.role;
          payload.is_active = values.is_active;
        }

        await updateUser(
          editingUser.id,
          payload,
        );

        if (isCurrentAccount) {
          await refreshUser();
        }

        setSuccessMessage(
          "User account updated successfully.",
        );
      } else {
        const payload: CreateUserRequest = {
          username: values.username,
          full_name: values.full_name,
          password: values.password,
          role: values.role,
          is_active: values.is_active,
        };

        await createUser(payload);

        setSuccessMessage(
          "User account created successfully.",
        );
      }

      setFormOpen(false);
      setEditingUser(null);

      await loadUsers();
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
        !statusUser ||
        !canManageUsers ||
        changingStatus
      ) {
        return;
      }

      if (statusUser.id === user?.id) {
        setStatusError(
          "The current account cannot change its own active status.",
        );
        return;
      }

      setChangingStatus(true);
      setStatusError(null);
      setSuccessMessage(null);

      try {
        await setUserActiveStatus(
          statusUser.id,
          !statusUser.is_active,
        );

        setSuccessMessage(
          statusUser.is_active
            ? "User account deactivated successfully."
            : "User account activated successfully.",
        );

        setStatusUser(null);

        await loadUsers();
      } catch (failure) {
        setStatusError(
          getApiErrorMessage(failure),
        );
      } finally {
        setChangingStatus(false);
      }
    };

  const columns = useMemo<
    DataTableColumn<UserAccount>[]
  >(
    () => [
      {
        key: "username",
        header: "Username",
        accessor: "username",
        sortable: true,
        render: (account) => (
          <div className="flex min-w-32 items-center gap-2">
            <UserRound
              size={17}
              className="shrink-0 text-secondary"
              aria-hidden="true"
            />

            <span className="font-medium text-text-primary">
              {account.username}
            </span>
          </div>
        ),
      },
      {
        key: "full_name",
        header: "Full name",
        accessor: "full_name",
        sortable: true,
      },
      {
        key: "role",
        header: "Role",
        render: (account) =>
          USER_ROLE_LABELS[account.role],
      },
      {
        key: "is_active",
        header: "Status",
        render: (account) => (
          <StatusBadge
            status={
              account.is_active
                ? "active"
                : "inactive"
            }
            label={
              account.is_active
                ? "Active"
                : "Inactive"
            }
            variant={
              account.is_active
                ? "success"
                : "neutral"
            }
            showDot
          />
        ),
      },
      {
        key: "created_at",
        header: "Created",
        render: (account) =>
          formatDateTime(
            account.created_at,
          ),
        hideOnMobile: true,
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (account) => (
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setViewingUser(account);
              }}
              className="app-button app-button-secondary inline-flex items-center gap-1.5"
              aria-label={`View ${account.username}`}
            >
              <Eye
                size={15}
                aria-hidden="true"
              />

              View
            </button>

            {canManageUsers && (
              <>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    openEditForm(account);
                  }}
                  className="app-button app-button-secondary inline-flex items-center gap-1.5"
                  aria-label={`Edit ${account.username}`}
                >
                  <Pencil
                    size={15}
                    aria-hidden="true"
                  />

                  Edit
                </button>

                {account.id !== user?.id && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setStatusError(null);
                      setStatusUser(account);
                    }}
                    className="app-button app-button-secondary"
                    aria-label={
                      account.is_active
                        ? `Deactivate ${account.username}`
                        : `Activate ${account.username}`
                    }
                  >
                    {account.is_active
                      ? "Deactivate"
                      : "Activate"}
                  </button>
                )}
              </>
            )}
          </div>
        ),
      },
    ],
    [canManageUsers, user?.id],
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
            Users
          </h2>

          <p className="app-page-description">
            Manage authorized accounts,
            assigned roles, and account status.
          </p>
        </div>

        {canManageUsers && (
          <button
            type="button"
            onClick={openCreateForm}
            className="app-button app-button-primary inline-flex items-center justify-center gap-2"
          >
            <Plus
              size={18}
              aria-hidden="true"
            />

            Add user
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
              htmlFor="user-search"
              className="app-sr-only"
            >
              Search users
            </label>

            <div className="relative min-w-0 flex-1">
              <Search
                size={17}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                aria-hidden="true"
              />

              <input
                id="user-search"
                type="search"
                value={searchInput}
                onChange={(event) =>
                  setSearchInput(
                    event.target.value,
                  )
                }
                placeholder="Search users..."
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
              void loadUsers();
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

        {loading && accounts.length === 0 ? (
          <LoadingState
            variant="section"
            message="Loading users..."
          />
        ) : (
          <DataTable<UserAccount>
            columns={columns}
            data={accounts}
            getRowId={(account) =>
              account.id
            }
            loading={loading}
            error={error}
            onRetry={() => loadUsers()}
            emptyMessage="No users found"
            emptyDescription={
              search
                ? "Try another search term."
                : "No user accounts are available."
            }
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              onPageChange: setPage,
            }}
            testId="users-table"
          />
        )}
      </section>

      {(formOpen || viewingUser) && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-primary/60 p-3 sm:p-6"
          onMouseDown={(event) => {
            if (
              event.target !==
              event.currentTarget
            ) {
              return;
            }

            if (viewingUser) {
              setViewingUser(null);
            } else {
              closeForm();
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-dialog-title"
            className={joinClasses(
              "flex max-h-[95vh] w-full max-w-3xl flex-col",
              "overflow-hidden rounded-card bg-surface shadow-xl",
            )}
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
              <div>
                <h3
                  id="user-dialog-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  {viewingUser
                    ? "User details"
                    : editingUser
                      ? "Edit user"
                      : "Add user"}
                </h3>

                {(viewingUser ||
                  editingUser) && (
                  <p className="mt-1 text-sm text-text-muted">
                    {(
                      viewingUser ??
                      editingUser
                    )?.username}
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  if (viewingUser) {
                    setViewingUser(null);
                  } else {
                    closeForm();
                  }
                }}
                disabled={saving}
                aria-label="Close user dialog"
                className="rounded-control p-2 text-text-muted hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X
                  size={20}
                  aria-hidden="true"
                />
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
              {viewingUser ? (
                <UserDetails
                  account={viewingUser}
                  onClose={() =>
                    setViewingUser(null)
                  }
                />
              ) : (
                <UserForm
                  key={
                    editingUser?.id ??
                    "new-user"
                  }
                  initialUser={editingUser}
                  currentUserId={
                    user?.id ?? null
                  }
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
        open={statusUser !== null}
        title={
          statusUser?.is_active
            ? "Deactivate user account?"
            : "Activate user account?"
        }
        message={
          statusUser?.is_active
            ? "The account will no longer be permitted to sign in. Existing business records and audit history will be preserved."
            : "The account will be permitted to sign in again, subject to backend authentication and authorization."
        }
        variant={
          statusUser?.is_active
            ? "warning"
            : "default"
        }
        confirmLabel={
          statusUser?.is_active
            ? "Deactivate"
            : "Activate"
        }
        isLoading={changingStatus}
        onCancel={() => {
          if (!changingStatus) {
            setStatusUser(null);
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

      <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
        <ShieldCheck
          size={20}
          className="mt-0.5 shrink-0 text-primary"
          aria-hidden="true"
        />

        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-text-primary">
            Role-based access control
          </h3>

          <p className="text-xs leading-5 text-text-muted">
            Account permissions are enforced
            by the backend. Accountant/Auditor
            and Owner accounts have read-only
            access to authorized information.
            Deactivating an account does not
            delete transaction or audit records.
          </p>
        </div>
      </div>

      {!canManageUsers && (
        <p className="flex items-start gap-2 text-xs text-text-muted">
          <Users
            size={15}
            className="shrink-0"
            aria-hidden="true"
          />

          User account information is available
          in read-only mode for this account.
        </p>
      )}
    </div>
  );
}

export default UsersPage;