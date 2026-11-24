import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Link, useNavigate } from "react-router-dom";

import {
  AlertCircle,
  ChevronDown,
  Cloud,
  CloudOff,
  LogOut,
  Menu,
  RefreshCw,
  ShieldCheck,
  UserRound,
  Wifi,
  WifiOff,
} from "lucide-react";

import {
  USER_ROLE_LABELS,
} from "../../types/auth";

import { useAuth } from "../../hooks/useAuth";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";

import {
  getApiErrorMessage,
} from "../../services/api/client";

import {
  getSyncServiceState,
  subscribeToSyncState,
} from "../../services/synchronization/syncService";

import { StatusBadge } from "./StatusBadge";

export interface AppHeaderProps {
  title?: string;
  subtitle?: string;
  onMenuClick?: () => void;
  sidebarOpen?: boolean;
  showMenuButton?: boolean;
  actions?: ReactNode;
  className?: string;
  testId?: string;
}

function joinClasses(
  ...classes: Array<
    string | false | null | undefined
  >
): string {
  return classes.filter(Boolean).join(" ");
}

function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) {
    return "U";
  }

  const first = parts[0]?.charAt(0) ?? "";
  const last =
    parts.length > 1
      ? parts[parts.length - 1]?.charAt(0) ?? ""
      : "";

  return `${first}${last}`.toUpperCase();
}

function useSynchronizationIndicator(): {
  isSyncing: boolean;
  lastError: string | null;
} {
  const [state, setState] = useState(
    getSyncServiceState,
  );

  useEffect(() => {
    return subscribeToSyncState((nextState) => {
      setState({ ...nextState });
    });
  }, []);

  return {
    isSyncing: state.isSyncing,
    lastError: state.lastError,
  };
}

/**
 * Application header with authenticated user information,
 * connectivity status, navigation access, and session controls.
 */
export function AppHeader({
  title = "Food Manufacturing Management System",
  subtitle,
  onMenuClick,
  sidebarOpen = false,
  showMenuButton = true,
  actions,
  className,
  testId,
}: AppHeaderProps) {
  const navigate = useNavigate();

  const {
    user,
    isAuthenticated,
    logout,
  } = useAuth();

  const {
    isOnline,
    isBackendReachable,
    checkConnection,
  } = useOnlineStatus();

  const {
    isSyncing,
    lastError: syncError,
  } = useSynchronizationIndicator();

  const [menuOpen, setMenuOpen] =
    useState(false);

  const [loggingOut, setLoggingOut] =
    useState(false);

  const [checkingConnection, setCheckingConnection] =
    useState(false);

  const [headerError, setHeaderError] =
    useState<string | null>(null);

  const userMenuRef =
    useRef<HTMLDivElement>(null);

  const userMenuButtonRef =
    useRef<HTMLButtonElement>(null);

  const userMenuId = "app-header-user-menu";

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const handlePointerDown = (
      event: PointerEvent,
    ): void => {
      if (
        event.target instanceof Node &&
        !userMenuRef.current?.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    };

    const handleKeyDown = (
      event: KeyboardEvent,
    ): void => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        userMenuButtonRef.current?.focus();
      }
    };

    document.addEventListener(
      "pointerdown",
      handlePointerDown,
    );

    document.addEventListener(
      "keydown",
      handleKeyDown,
    );

    return () => {
      document.removeEventListener(
        "pointerdown",
        handlePointerDown,
      );

      document.removeEventListener(
        "keydown",
        handleKeyDown,
      );
    };
  }, [menuOpen]);

  useEffect(() => {
    setMenuOpen(false);
    setHeaderError(null);
  }, [user?.id]);

  const handleLogout = async (): Promise<void> => {
    if (loggingOut) {
      return;
    }

    setLoggingOut(true);
    setHeaderError(null);
    setMenuOpen(false);

    try {
      await logout();
      navigate("/login", {
        replace: true,
      });
    } catch (error) {
      setHeaderError(
        getApiErrorMessage(error),
      );
    } finally {
      setLoggingOut(false);
    }
  };

  const handleCheckConnection =
    async (): Promise<void> => {
      if (checkingConnection) {
        return;
      }

      setCheckingConnection(true);
      setHeaderError(null);

      try {
        await checkConnection();
      } catch (error) {
        setHeaderError(
          getApiErrorMessage(error),
        );
      } finally {
        setCheckingConnection(false);
      }
    };

  const connectionStatus =
    !isOnline
      ? "offline"
      : isBackendReachable === false
        ? "backend_unavailable"
        : isBackendReachable === true
          ? "connected"
          : "online";

  const connectionLabel =
    !isOnline
      ? "Offline"
      : isBackendReachable === false
        ? "Server unavailable"
        : isBackendReachable === true
          ? "Connected"
          : "Online";

  const connectionDescription =
    !isOnline
      ? "No network connection is available."
      : isBackendReachable === false
        ? "The backend could not be reached."
        : isBackendReachable === true
          ? "The backend connection is available."
          : "Network access is available. Backend connectivity has not been confirmed.";

  const roleLabel = user
    ? USER_ROLE_LABELS[user.role]
    : "";

  const displayName =
    user?.full_name?.trim() ||
    user?.username ||
    "User";

  return (
    <header
      className={joinClasses(
        "relative z-20 w-full border-b border-border bg-surface",
        className,
      )}
      data-testid={testId}
    >
      <div className="flex min-h-16 items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {showMenuButton && onMenuClick && (
            <button
              type="button"
              onClick={onMenuClick}
              aria-label={
                sidebarOpen
                  ? "Close navigation menu"
                  : "Open navigation menu"
              }
              aria-expanded={sidebarOpen}
              aria-controls="app-sidebar"
              className={joinClasses(
                "inline-flex h-10 w-10 shrink-0 items-center justify-center",
                "rounded-control border border-border",
                "text-primary transition-colors",
                "hover:bg-background",
                "focus-visible:outline-2 focus-visible:outline-offset-2",
                "focus-visible:outline-accent",
                "lg:hidden",
              )}
            >
              <Menu
                size={21}
                aria-hidden="true"
              />
            </button>
          )}

          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold leading-6 text-text-primary sm:text-lg">
              {title}
            </h1>

            {subtitle && (
              <p className="mt-0.5 truncate text-xs text-text-muted sm:text-sm">
                {subtitle}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {actions && (
            <div className="hidden items-center gap-2 sm:flex">
              {actions}
            </div>
          )}

          <div
            className="flex items-center gap-1.5"
            title={connectionDescription}
          >
            <span
              className="hidden sm:inline-flex"
              aria-hidden="true"
            >
              {!isOnline ? (
                <WifiOff
                  size={17}
                  className="text-warning"
                />
              ) : isBackendReachable === false ? (
                <CloudOff
                  size={17}
                  className="text-warning"
                />
              ) : isBackendReachable === true ? (
                <Cloud
                  size={17}
                  className="text-success"
                />
              ) : (
                <Wifi
                  size={17}
                  className="text-secondary"
                />
              )}
            </span>

            <StatusBadge
              status={connectionStatus}
              label={connectionLabel}
              showDot
              showIcon={false}
              className="hidden sm:inline-flex"
            />

            <span className="sm:hidden">
              <StatusBadge
                status={connectionStatus}
                label={connectionLabel}
                showDot
                showIcon={false}
                size="sm"
              />
            </span>
          </div>

          {user?.role === "salesman" && isSyncing && (
            <span
              className="hidden items-center gap-1.5 text-xs text-accent md:inline-flex"
              role="status"
              aria-live="polite"
            >
              <RefreshCw
                size={14}
                className="motion-safe:animate-spin"
                aria-hidden="true"
              />
              Syncing orders
            </span>
          )}

          {isAuthenticated && user && (
            <div
              ref={userMenuRef}
              className="relative"
            >
              <button
                ref={userMenuButtonRef}
                type="button"
                onClick={() => {
                  setMenuOpen((current) => !current);
                }}
                aria-label={`Account menu for ${displayName}`}
                aria-haspopup="true"
                aria-expanded={menuOpen}
                aria-controls={userMenuId}
                disabled={loggingOut}
                className={joinClasses(
                  "inline-flex min-h-10 items-center gap-2",
                  "rounded-control border border-border",
                  "bg-surface px-2 py-1.5 text-left",
                  "transition-colors hover:bg-background",
                  "focus-visible:outline-2 focus-visible:outline-offset-2",
                  "focus-visible:outline-accent",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  "sm:px-3",
                )}
              >
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white"
                  aria-hidden="true"
                >
                  {getInitials(displayName)}
                </span>

                <span className="hidden min-w-0 flex-col md:flex">
                  <span className="max-w-36 truncate text-sm font-medium text-text-primary">
                    {displayName}
                  </span>

                  <span className="max-w-36 truncate text-xs text-text-muted">
                    {roleLabel}
                  </span>
                </span>

                <ChevronDown
                  size={15}
                  className={joinClasses(
                    "hidden shrink-0 text-text-muted transition-transform sm:block",
                    menuOpen && "rotate-180",
                  )}
                  aria-hidden="true"
                />
              </button>

              {menuOpen && (
                <div
                  id={userMenuId}
                  className={joinClasses(
                    "absolute right-0 top-full z-50 mt-2 w-64",
                    "overflow-hidden rounded-card border border-border",
                    "bg-surface shadow-lg",
                  )}
                >
                  <div className="border-b border-border px-4 py-3">
                    <div className="flex items-start gap-3">
                      <UserRound
                        size={19}
                        className="mt-0.5 shrink-0 text-secondary"
                        aria-hidden="true"
                      />

                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-text-primary">
                          {displayName}
                        </p>

                        <p className="truncate text-xs text-text-muted">
                          @{user.username}
                        </p>

                        <div className="mt-2 flex items-center gap-1.5 text-xs text-secondary">
                          <ShieldCheck
                            size={14}
                            aria-hidden="true"
                          />
                          <span>{roleLabel}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="p-2">
                    <button
                      type="button"
                      onClick={() => {
                        void handleCheckConnection();
                      }}
                      disabled={checkingConnection}
                      className={joinClasses(
                        "flex w-full items-center gap-3",
                        "rounded-control px-3 py-2.5 text-left",
                        "text-sm text-text-primary",
                        "hover:bg-background",
                        "focus-visible:outline-2 focus-visible:outline-accent",
                        "disabled:cursor-not-allowed disabled:opacity-60",
                      )}
                    >
                      <RefreshCw
                        size={17}
                        className={
                          checkingConnection
                            ? "motion-safe:animate-spin"
                            : ""
                        }
                        aria-hidden="true"
                      />

                      <span>
                        {checkingConnection
                          ? "Checking connection..."
                          : "Check connection"}
                      </span>
                    </button>

                    {user.role === "salesman" && (
                      <Link
                        to="/offline-orders"
                        onClick={() => {
                          setMenuOpen(false);
                        }}
                        className={joinClasses(
                          "flex w-full items-center gap-3",
                          "rounded-control px-3 py-2.5",
                          "text-sm text-text-primary",
                          "hover:bg-background",
                          "focus-visible:outline-2 focus-visible:outline-accent",
                        )}
                      >
                        <CloudOff
                          size={17}
                          aria-hidden="true"
                        />

                        <span>
                          Offline orders
                        </span>
                      </Link>
                    )}

                    <div className="my-2 border-t border-border" />

                    <button
                      type="button"
                      onClick={() => {
                        void handleLogout();
                      }}
                      disabled={loggingOut}
                      className={joinClasses(
                        "flex w-full items-center gap-3",
                        "rounded-control px-3 py-2.5 text-left",
                        "text-sm font-medium text-error",
                        "hover:bg-error/5",
                        "focus-visible:outline-2 focus-visible:outline-error",
                        "disabled:cursor-not-allowed disabled:opacity-60",
                      )}
                    >
                      <LogOut
                        size={17}
                        aria-hidden="true"
                      />

                      <span>
                        {loggingOut
                          ? "Signing out..."
                          : "Sign out"}
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {(headerError ||
        (user?.role === "salesman" &&
          syncError)) && (
        <div
          role="alert"
          className="flex items-start gap-2 border-t border-error/20 bg-error/5 px-4 py-2 text-xs text-error sm:px-6 lg:px-8"
        >
          <AlertCircle
            size={15}
            className="shrink-0"
            aria-hidden="true"
          />

          <span>
            {headerError ?? syncError}
          </span>

          {headerError && (
            <button
              type="button"
              onClick={() => {
                setHeaderError(null);
              }}
              className="ml-auto shrink-0 font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </header>
  );
}

export default AppHeader;