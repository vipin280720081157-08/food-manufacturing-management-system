import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";

import {
  AlertCircle,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  UserRound,
  WifiOff,
} from "lucide-react";

import type {
  LoginCredentials,
} from "../../types/auth";

import {
  useAuth,
} from "../../hooks/useAuth";

import {
  useOnlineStatus,
} from "../../hooks/useOnlineStatus";

import {
  ApiError,
  getApiErrorMessage,
  isApiError,
} from "../../services/api/client";
import { getDemoLoginOptions, type DemoLoginOptions } from "../../services/api/authApi";

import {
  LoadingState,
} from "../../components/common/LoadingState";

interface LoginFormErrors {
  username?: string;
  password?: string;
}

interface LoginLocationState {
  from?: {
    pathname?: unknown;
    search?: unknown;
    hash?: unknown;
  };
}

const DEFAULT_REDIRECT_PATH = "/dashboard";

function joinClasses(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

function getRedirectPath(
  state: unknown,
): string {
  if (
    typeof state !== "object" ||
    state === null
  ) {
    return DEFAULT_REDIRECT_PATH;
  }

  const locationState =
    state as LoginLocationState;

  const from = locationState.from;

  if (!from) {
    return DEFAULT_REDIRECT_PATH;
  }

  const pathname = from.pathname;

  if (
    typeof pathname !== "string" ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.startsWith("/\\") ||
    pathname === "/login"
  ) {
    return DEFAULT_REDIRECT_PATH;
  }

  const search =
    typeof from.search === "string" &&
    (from.search === "" ||
      (from.search.startsWith("?") &&
        !from.search.startsWith("??")))
      ? from.search
      : "";

  const hash =
    typeof from.hash === "string" &&
    (from.hash === "" ||
      from.hash.startsWith("#"))
      ? from.hash
      : "";

  return `${pathname}${search}${hash}`;
}

function validateCredentials(
  credentials: LoginCredentials,
): LoginFormErrors {
  const errors: LoginFormErrors = {};

  if (!credentials.username.trim()) {
    errors.username = "Username is required.";
  }

  if (!credentials.password) {
    errors.password = "Password is required.";
  }

  return errors;
}

function getLoginErrorMessage(
  error: unknown,
): string {
  if (isApiError(error)) {
    if (
      error.status === 401 ||
      error.category === "authentication"
    ) {
      return "Invalid username or password.";
    }

    if (
      error.status === 403 ||
      error.category === "authorization"
    ) {
      return "This account is not permitted to sign in. Contact the system administrator.";
    }

    if (
      error.category === "network" ||
      error.category === "timeout"
    ) {
      return "The authentication server could not be reached. Check the network connection and try again.";
    }

    if (error.status === 429) {
      return "Too many sign-in attempts. Wait before trying again.";
    }

    if (
      error.category === "server"
    ) {
      return "The authentication service is temporarily unavailable. Try again later.";
    }
  }

  return getApiErrorMessage(error);
}

/**
 * Authenticates users through AuthProvider and the backend API.
 * Credentials are not persisted in browser storage.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();

  const {
    login,
    isAuthenticated,
    isLoading,
    status,
    user,
  } = useAuth();

  const {
    isOnline,
  } = useOnlineStatus();

  const generatedId = useId();

  const usernameId =
    `${generatedId}-username`;

  const passwordId =
    `${generatedId}-password`;

  const usernameErrorId =
    `${generatedId}-username-error`;

  const passwordErrorId =
    `${generatedId}-password-error`;

  const loginErrorId =
    `${generatedId}-login-error`;

  const usernameInputRef =
    useRef<HTMLInputElement>(null);

  const passwordInputRef =
    useRef<HTMLInputElement>(null);

  const submittingRef = useRef(false);

  const [credentials, setCredentials] =
    useState<LoginCredentials>({
      username: "",
      password: "",
    });

  const [formErrors, setFormErrors] =
    useState<LoginFormErrors>({});

  const [loginError, setLoginError] =
    useState<string | null>(null);

  const [showPassword, setShowPassword] =
    useState(false);

  const [submitting, setSubmitting] =
    useState(false);

  const [demoOptions, setDemoOptions] =
    useState<DemoLoginOptions | null>(null);

  useEffect(() => {
    let active = true;
    void getDemoLoginOptions().then((options) => {
      if (active) setDemoOptions(options);
    });
    return () => { active = false; };
  }, []);

  const redirectPath = getRedirectPath(
    location.state,
  );

  useEffect(() => {
    if (
      !isLoading &&
      !isAuthenticated
    ) {
      usernameInputRef.current?.focus();
    }
  }, [isLoading, isAuthenticated]);

  const handleUsernameChange = (
    value: string,
  ): void => {
    setCredentials((current) => ({
      ...current,
      username: value,
    }));

    setFormErrors((current) => ({
      ...current,
      username: undefined,
    }));

    setLoginError(null);
  };

  const handlePasswordChange = (
    value: string,
  ): void => {
    setCredentials((current) => ({
      ...current,
      password: value,
    }));

    setFormErrors((current) => ({
      ...current,
      password: undefined,
    }));

    setLoginError(null);
  };

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (
      submittingRef.current ||
      isLoading ||
      isAuthenticated
    ) {
      return;
    }

    setLoginError(null);

    const validationErrors =
      validateCredentials(credentials);

    setFormErrors(validationErrors);

    if (validationErrors.username) {
      usernameInputRef.current?.focus();
      return;
    }

    if (validationErrors.password) {
      passwordInputRef.current?.focus();
      return;
    }

    if (!isOnline) {
      setLoginError(
        "An internet connection is required to sign in. Previously saved offline orders remain stored on this device.",
      );
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);

    try {
      await login({
        username: credentials.username.trim(),
        password: credentials.password,
      });

      setCredentials((current) => ({
        ...current,
        password: "",
      }));

      navigate(redirectPath, {
        replace: true,
        state: null,
      });
    } catch (error: unknown) {
      setCredentials((current) => ({
        ...current,
        password: "",
      }));

      setLoginError(
        getLoginErrorMessage(error),
      );

      if (
        error instanceof ApiError &&
        error.status === 422
      ) {
        setFormErrors({
          username:
            "Check the entered username.",
          password:
            "Check the entered password.",
        });
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleQuickDemoLogin = async (username: string): Promise<void> => {
    if (submittingRef.current || !demoOptions?.password || !isOnline) return;
    submittingRef.current = true;
    setSubmitting(true);
    setLoginError(null);
    try {
      await login({ username, password: demoOptions.password });
      navigate(redirectPath, { replace: true, state: null });
    } catch (error: unknown) {
      setLoginError(getLoginErrorMessage(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (
    isLoading ||
    status === "initializing"
  ) {
    return (
      <LoadingState
        variant="section"
        size="lg"
        message="Checking authentication..."
        minHeight={320}
      />
    );
  }

  if (
    isAuthenticated &&
    status === "authenticated" &&
    user?.is_active
  ) {
    return (
      <Navigate
        to={redirectPath}
        replace
      />
    );
  }

  const formDisabled = submitting;

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="mb-8">
        <span
          className={joinClasses(
            "mb-4 inline-flex h-12 w-12 items-center justify-center",
            "rounded-control bg-primary/10 text-primary",
          )}
          aria-hidden="true"
        >
          <LockKeyhole
            size={24}
            strokeWidth={1.8}
          />
        </span>

        <h2 className="text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
          Sign in
        </h2>

        <p className="mt-2 text-sm leading-6 text-text-muted">
          Enter the assigned account credentials to
          access the management system.
        </p>
      </div>

      {!isOnline && (
        <div
          role="status"
          className={joinClasses(
            "mb-5 flex items-start gap-3",
            "rounded-control border border-warning/25",
            "bg-warning/5 px-4 py-3",
          )}
        >
          <WifiOff
            size={19}
            className="mt-0.5 shrink-0 text-warning"
            aria-hidden="true"
          />

          <div>
            <p className="text-sm font-semibold text-warning">
              Network unavailable
            </p>

            <p className="mt-1 text-xs leading-5 text-text-muted">
              Signing in requires a connection to
              the authentication server. Existing
              offline orders are not deleted.
            </p>
          </div>
        </div>
      )}

      {loginError && (
        <div
          id={loginErrorId}
          role="alert"
          className={joinClasses(
            "mb-5 flex items-start gap-3",
            "rounded-control border border-error/25",
            "bg-error/5 px-4 py-3",
          )}
        >
          <AlertCircle
            size={19}
            className="mt-0.5 shrink-0 text-error"
            aria-hidden="true"
          />

          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-error">
              Sign-in failed
            </p>

            <p className="mt-1 text-sm leading-5 text-text-primary">
              {loginError}
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              setLoginError(null);
            }}
            className="shrink-0 text-xs font-medium text-error underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
          >
            Dismiss
          </button>
        </div>
      )}

      <form
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        noValidate
        className="space-y-5"
        aria-busy={submitting}
        aria-describedby={
          loginError
            ? loginErrorId
            : undefined
        }
      >
        <div>
          <label
            htmlFor={usernameId}
            className="app-field-label mb-2 block"
          >
            Username
            <span
              className="ml-1 text-error"
              aria-hidden="true"
            >
              *
            </span>
          </label>

          <div className="relative">
            <UserRound
              size={18}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              aria-hidden="true"
            />

            <input
              ref={usernameInputRef}
              id={usernameId}
              name="username"
              type="text"
              value={credentials.username}
              onChange={(event) => {
                handleUsernameChange(
                  event.target.value,
                );
              }}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              maxLength={150}
              disabled={formDisabled}
              aria-invalid={
                Boolean(formErrors.username)
              }
              aria-describedby={
                formErrors.username
                  ? usernameErrorId
                  : undefined
              }
              placeholder="Enter username"
              className={joinClasses(
                "app-input app-input-icon-leading app-login-input-leading w-full",
                formErrors.username &&
                  "border-error",
              )}
            />
          </div>

          {formErrors.username && (
            <p
              id={usernameErrorId}
              className="app-field-error mt-1.5"
            >
              {formErrors.username}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor={passwordId}
            className="app-field-label mb-2 block"
          >
            Password
            <span
              className="ml-1 text-error"
              aria-hidden="true"
            >
              *
            </span>
          </label>

          <div className="relative">
            <LockKeyhole
              size={18}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              aria-hidden="true"
            />

            <input
              ref={passwordInputRef}
              id={passwordId}
              name="password"
              type={
                showPassword
                  ? "text"
                  : "password"
              }
              value={credentials.password}
              onChange={(event) => {
                handlePasswordChange(
                  event.target.value,
                );
              }}
              autoComplete="current-password"
              required
              disabled={formDisabled}
              aria-invalid={
                Boolean(formErrors.password)
              }
              aria-describedby={
                formErrors.password
                  ? passwordErrorId
                  : undefined
              }
              placeholder="Enter password"
              className={joinClasses(
                "app-input app-input-icon-leading app-login-input-leading app-input-icon-trailing w-full pr-12",
                formErrors.password &&
                  "border-error",
              )}
            />

            <button
              type="button"
              onClick={() => {
                setShowPassword(
                  (current) => !current,
                );
              }}
              disabled={formDisabled}
              aria-label={
                showPassword
                  ? "Hide password"
                  : "Show password"
              }
              aria-pressed={showPassword}
              className={joinClasses(
                "absolute right-2 top-1/2",
                "flex h-9 w-9 -translate-y-1/2",
                "items-center justify-center",
                "rounded-control text-text-muted",
                "hover:bg-background hover:text-primary",
                "focus-visible:outline-2",
                "focus-visible:outline-offset-2",
                "focus-visible:outline-accent",
                "disabled:cursor-not-allowed",
                "disabled:opacity-50",
              )}
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

          {formErrors.password && (
            <p
              id={passwordErrorId}
              className="app-field-error mt-1.5"
            >
              {formErrors.password}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={
            formDisabled ||
            !isOnline
          }
          className={joinClasses(
            "app-button app-button-primary",
            "flex min-h-11 w-full items-center justify-center gap-2",
            "font-semibold",
            "disabled:cursor-not-allowed",
            "disabled:opacity-60",
          )}
        >
          {submitting ? (
            <>
              <LoaderCircle
                size={18}
                className="motion-safe:animate-spin"
                aria-hidden="true"
              />

              <span>
                Signing in...
              </span>
            </>
          ) : (
            <>
              <LogIn
                size={18}
                aria-hidden="true"
              />

              <span>
                Sign in
              </span>
            </>
          )}
        </button>
      </form>

      {demoOptions && (
        <section className="mt-6 rounded-control border border-border bg-background/70 p-4" aria-labelledby={`${generatedId}-demo-title`}>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 id={`${generatedId}-demo-title`} className="text-sm font-semibold text-text-primary">Quick Demo Login</h3>
              <p className="mt-1 text-xs text-text-muted">Choose a role to sign in instantly.</p>
            </div>
            <p className="rounded-control bg-surface px-2.5 py-1 text-xs text-text-muted">Password: <span className="font-semibold text-text-primary">{demoOptions.password}</span></p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {demoOptions.accounts.map((account) => (
              <button
                key={account.username}
                type="button"
                onClick={() => { void handleQuickDemoLogin(account.username); }}
                disabled={formDisabled || !isOnline}
                className="flex min-h-12 flex-col items-start justify-center rounded-control border border-border bg-surface px-3 py-2 text-left transition hover:border-primary hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
                aria-label={`Sign in as ${account.label} (${account.username})`}
              >
                <span className="text-sm font-semibold text-text-primary">{account.label}</span>
                <span className="text-xs text-text-muted">{account.username}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="mt-7 border-t border-border pt-5">
        <p className="text-center text-xs leading-5 text-text-muted">
          Access is restricted to authorized personnel.
          Account creation and role assignment are
          managed by the system administrator.
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
