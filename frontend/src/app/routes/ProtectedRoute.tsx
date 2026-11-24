import type { ReactNode } from "react";

import {
  Link,
  Navigate,
  Outlet,
  useLocation,
} from "react-router-dom";

import {
  ArrowLeft,
  LayoutDashboard,
  LockKeyhole,
  ShieldAlert,
} from "lucide-react";

import type {
  UserRole,
} from "../../types/auth";

import {
  USER_ROLE_LABELS,
} from "../../types/auth";

import {
  useAuth,
} from "../../hooks/useAuth";

import {
  LoadingState,
} from "../../components/common/LoadingState";

export interface ProtectedRouteProps {
  children?: ReactNode;
  allowedRoles?: readonly UserRole[];
  redirectTo?: string;
  loadingMessage?: string;
  showAccessDenied?: boolean;
}

export interface RoleGuardProps {
  children: ReactNode;
  allowedRoles: readonly UserRole[];
  fallback?: ReactNode;
}

export interface GuestRouteProps {
  children?: ReactNode;
  redirectTo?: string;
  loadingMessage?: string;
}

export interface AccessDeniedProps {
  allowedRoles?: readonly UserRole[];
  showBackButton?: boolean;
  showDashboardButton?: boolean;
  className?: string;
}

const DEFAULT_LOGIN_PATH = "/login";
const DEFAULT_DASHBOARD_PATH = "/dashboard";

function joinClasses(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

function isAllowedRole(
  role: UserRole,
  allowedRoles?: readonly UserRole[],
): boolean {
  if (allowedRoles === undefined) {
    return true;
  }

  return allowedRoles.includes(role);
}

function getSafeRedirectPath(
  requestedPath: string | undefined,
  fallback: string,
): string {
  if (
    !requestedPath ||
    !requestedPath.startsWith("/") ||
    requestedPath.startsWith("//") ||
    requestedPath.startsWith("/\\")
  ) {
    return fallback;
  }

  return requestedPath;
}

/**
 * Restricts frontend route rendering according to authentication
 * and assigned user roles. Backend authorization remains authoritative.
 */
export function ProtectedRoute({
  children,
  allowedRoles,
  redirectTo = DEFAULT_LOGIN_PATH,
  loadingMessage = "Checking authentication...",
  showAccessDenied = true,
}: ProtectedRouteProps) {
  const location = useLocation();

  const {
    user,
    status,
    isAuthenticated,
    isLoading,
  } = useAuth();

  if (isLoading || status === "initializing") {
    return (
      <LoadingState
        variant="page"
        size="lg"
        message={loadingMessage}
        minHeight={320}
      />
    );
  }

  if (
    !isAuthenticated ||
    status !== "authenticated" ||
    !user ||
    !user.is_active
  ) {
    return (
      <Navigate
        to={getSafeRedirectPath(
          redirectTo,
          DEFAULT_LOGIN_PATH,
        )}
        replace
        state={{
          from: {
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
          },
        }}
      />
    );
  }

  if (!isAllowedRole(user.role, allowedRoles)) {
    if (showAccessDenied) {
      return (
        <AccessDenied
          allowedRoles={allowedRoles}
        />
      );
    }

    return (
      <Navigate
        to={DEFAULT_DASHBOARD_PATH}
        replace
      />
    );
  }

  return <>{children ?? <Outlet />}</>;
}

/**
 * Conditionally displays an action or section for permitted roles.
 * This component does not authorize backend operations.
 */
export function RoleGuard({
  children,
  allowedRoles,
  fallback = null,
}: RoleGuardProps) {
  const {
    user,
    isAuthenticated,
    isLoading,
  } = useAuth();

  if (
    isLoading ||
    !isAuthenticated ||
    !user ||
    !user.is_active ||
    !isAllowedRole(user.role, allowedRoles)
  ) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}

/**
 * Redirects authenticated users away from guest-only screens.
 */
export function GuestRoute({
  children,
  redirectTo = DEFAULT_DASHBOARD_PATH,
  loadingMessage = "Checking authentication...",
}: GuestRouteProps) {
  const location = useLocation();

  const {
    user,
    status,
    isAuthenticated,
    isLoading,
  } = useAuth();

  if (isLoading || status === "initializing") {
    return (
      <LoadingState
        variant="page"
        size="lg"
        message={loadingMessage}
        minHeight={320}
      />
    );
  }

  if (
    isAuthenticated &&
    status === "authenticated" &&
    user?.is_active
  ) {
    const requestedLocation = location.state as
      | {
          from?: {
            pathname?: unknown;
            search?: unknown;
            hash?: unknown;
          };
        }
      | null;

    const from = requestedLocation?.from;

    const pathname =
      typeof from?.pathname === "string"
        ? from.pathname
        : undefined;

    const search =
      typeof from?.search === "string" &&
      !from.search.startsWith("//")
        ? from.search
        : "";

    const hash =
      typeof from?.hash === "string"
        ? from.hash
        : "";

    const safePath = getSafeRedirectPath(
      pathname,
      getSafeRedirectPath(
        redirectTo,
        DEFAULT_DASHBOARD_PATH,
      ),
    );

    const destination =
      safePath === DEFAULT_LOGIN_PATH
        ? DEFAULT_DASHBOARD_PATH
        : safePath;

    return (
      <Navigate
        to={{
          pathname: destination,
          search:
            destination === safePath
              ? search
              : "",
          hash:
            destination === safePath
              ? hash
              : "",
        }}
        replace
      />
    );
  }

  return <>{children ?? <Outlet />}</>;
}

/**
 * Displays an access-denied message without disclosing
 * restricted business data.
 */
export function AccessDenied({
  allowedRoles,
  showBackButton = true,
  showDashboardButton = true,
  className,
}: AccessDeniedProps) {
  const location = useLocation();

  const permittedRoleLabels = allowedRoles
    ?.map((role) => USER_ROLE_LABELS[role])
    .filter(Boolean);

  const hasRoleInformation =
    permittedRoleLabels !== undefined &&
    permittedRoleLabels.length > 0;

  const canGoBack =
    showBackButton &&
    typeof window !== "undefined" &&
    window.history.length > 1;

  return (
    <main
      className={joinClasses(
        "flex min-h-[60vh] w-full items-center justify-center",
        "px-4 py-10 sm:px-6",
        className,
      )}
    >
      <section
        aria-labelledby="access-denied-title"
        aria-describedby="access-denied-description"
        className={joinClasses(
          "w-full max-w-lg rounded-card",
          "border border-border bg-surface",
          "px-6 py-8 text-center shadow-card",
          "sm:px-10 sm:py-10",
        )}
      >
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-error/10 text-error">
          <ShieldAlert
            size={32}
            strokeWidth={1.7}
            aria-hidden="true"
          />
        </div>

        <h1
          id="access-denied-title"
          className="mt-6 text-xl font-semibold text-text-primary sm:text-2xl"
        >
          Access denied
        </h1>

        <p
          id="access-denied-description"
          className="mt-3 text-sm leading-6 text-text-muted"
        >
          The current account does not have permission
          to access this section.
        </p>

        {hasRoleInformation && (
          <div className="mt-6 rounded-control border border-border bg-background px-4 py-3 text-left">
            <div className="flex items-start gap-3">
              <LockKeyhole
                size={18}
                className="mt-0.5 shrink-0 text-secondary"
                aria-hidden="true"
              />

              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-secondary">
                  Permitted roles
                </p>

                <p className="mt-1 text-sm leading-6 text-text-primary">
                  {permittedRoleLabels.join(", ")}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="mt-7 flex flex-col-reverse justify-center gap-3 sm:flex-row">
          {canGoBack && (
            <Link
              to={DEFAULT_DASHBOARD_PATH}
              state={{
                deniedFrom: location.pathname,
              }}
              className={joinClasses(
                "app-button app-button-secondary",
                "inline-flex min-h-10 items-center justify-center gap-2",
              )}
            >
              <ArrowLeft
                size={17}
                aria-hidden="true"
              />

              Return to dashboard
            </Link>
          )}

          {showDashboardButton && !canGoBack && (
            <Link
              to={DEFAULT_DASHBOARD_PATH}
              className={joinClasses(
                "app-button app-button-primary",
                "inline-flex min-h-10 items-center justify-center gap-2",
              )}
            >
              <LayoutDashboard
                size={17}
                aria-hidden="true"
              />

              Go to dashboard
            </Link>
          )}
        </div>
      </section>
    </main>
  );
}

export default ProtectedRoute;