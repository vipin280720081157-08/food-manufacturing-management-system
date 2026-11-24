import {
  useId,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  AlertCircle,
  AlertTriangle,
  LockKeyhole,
  RefreshCw,
  WifiOff,
  XCircle,
} from "lucide-react";

import {
  ApiError,
  getApiErrorMessage,
  isApiError,
} from "../../services/api/client";

export type ErrorStateVariant =
  | "page"
  | "section"
  | "inline"
  | "banner";

export type ErrorStateSeverity =
  | "error"
  | "warning";

export type ErrorStateProps = {
  error?: unknown;
  title?: string;
  message?: string;
  description?: string;
  variant?: ErrorStateVariant;
  severity?: ErrorStateSeverity;
  onRetry?: () => void | Promise<void>;
  retryLabel?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
  isRetrying?: boolean;
  showRetry?: boolean;
  showIcon?: boolean;
  className?: string;
  minHeight?: number | string;
  children?: ReactNode;
  testId?: string;
};

interface ResolvedError {
  title: string;
  message: string;
  severity: ErrorStateSeverity;
  retryable: boolean;
  icon:
    | "network"
    | "authorization"
    | "warning"
    | "error";
}

const DEFAULT_ERROR_TITLE =
  "Unable to load information";

const DEFAULT_ERROR_MESSAGE =
  "An unexpected error occurred. Please try again.";

const VARIANT_CLASSES: Record<
  ErrorStateVariant,
  string
> = {
  page: [
    "flex min-h-[50vh] w-full flex-col",
    "items-center justify-center",
    "gap-4 px-4 py-12 text-center",
  ].join(" "),

  section: [
    "flex w-full flex-col",
    "items-center justify-center gap-3",
    "rounded-card border border-border",
    "bg-surface px-5 py-8 text-center",
  ].join(" "),

  inline: [
    "flex w-full items-start gap-3",
    "rounded-control border border-error/20",
    "bg-error/5 px-4 py-3 text-left",
  ].join(" "),

  banner: [
    "flex w-full items-start gap-3",
    "rounded-control border border-error/25",
    "bg-error/5 px-4 py-3 text-left",
  ].join(" "),
};

function joinClasses(
  ...classes: Array<
    string | false | null | undefined
  >
): string {
  return classes.filter(Boolean).join(" ");
}

function getMinHeightStyle(
  minHeight: number | string | undefined,
): CSSProperties | undefined {
  if (minHeight === undefined) {
    return undefined;
  }

  return {
    minHeight:
      typeof minHeight === "number"
        ? `${Math.max(0, minHeight)}px`
        : minHeight,
  };
}

function resolveApiError(
  error: ApiError,
): ResolvedError {
  const message = getApiErrorMessage(error);

  switch (error.category) {
    case "network":
    case "timeout":
      return {
        title: "Connection unavailable",
        message,
        severity: "warning",
        retryable: error.retryable,
        icon: "network",
      };

    case "authentication":
      return {
        title: "Authentication required",
        message,
        severity: "warning",
        retryable: false,
        icon: "authorization",
      };

    case "authorization":
      return {
        title: "Access restricted",
        message,
        severity: "warning",
        retryable: false,
        icon: "authorization",
      };

    case "validation":
      return {
        title: "Validation failed",
        message,
        severity: "warning",
        retryable: false,
        icon: "warning",
      };

    case "conflict":
      return {
        title: "Request conflict",
        message,
        severity: "warning",
        retryable: false,
        icon: "warning",
      };

    case "not_found":
      return {
        title: "Information not found",
        message,
        severity: "warning",
        retryable: false,
        icon: "warning",
      };

    case "rate_limit":
      return {
        title: "Request limit reached",
        message,
        severity: "warning",
        retryable: error.retryable,
        icon: "warning",
      };

    case "server":
    case "unknown":
    default:
      return {
        title: DEFAULT_ERROR_TITLE,
        message,
        severity: "error",
        retryable: error.retryable,
        icon: "error",
      };
  }
}

function resolveError(
  error: unknown,
): ResolvedError {
  if (isApiError(error)) {
    return resolveApiError(error);
  }

  if (
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return {
      title: "Request cancelled",
      message: "The operation was cancelled.",
      severity: "warning",
      retryable: false,
      icon: "warning",
    };
  }

  if (error instanceof Error) {
    return {
      title: DEFAULT_ERROR_TITLE,
      message:
        error.message.trim() ||
        DEFAULT_ERROR_MESSAGE,
      severity: "error",
      retryable: true,
      icon: "error",
    };
  }

  if (
    typeof error === "string" &&
    error.trim()
  ) {
    return {
      title: DEFAULT_ERROR_TITLE,
      message: error.trim(),
      severity: "error",
      retryable: true,
      icon: "error",
    };
  }

  return {
    title: DEFAULT_ERROR_TITLE,
    message: DEFAULT_ERROR_MESSAGE,
    severity: "error",
    retryable: true,
    icon: "error",
  };
}

function ErrorIcon({
  icon,
  severity,
  size,
}: {
  icon: ResolvedError["icon"];
  severity: ErrorStateSeverity;
  size: number;
}) {
  const className =
    severity === "warning"
      ? "text-warning"
      : "text-error";

  const props = {
    size,
    strokeWidth: 1.8,
    className,
    "aria-hidden": true as const,
  };

  switch (icon) {
    case "network":
      return <WifiOff {...props} />;

    case "authorization":
      return <LockKeyhole {...props} />;

    case "warning":
      return <AlertTriangle {...props} />;

    case "error":
    default:
      return <AlertCircle {...props} />;
  }
}

/**
 * Displays actionable errors without implying that a failed
 * backend operation has completed successfully.
 */
export function ErrorState({
  error,
  title,
  message,
  description,
  variant = "section",
  severity,
  onRetry,
  retryLabel = "Try again",
  onDismiss,
  dismissLabel = "Dismiss error",
  isRetrying = false,
  showRetry = true,
  showIcon = true,
  className,
  minHeight,
  children,
  testId,
}: ErrorStateProps) {
  const titleId = useId();
  const messageId = useId();

  const [internalRetrying, setInternalRetrying] =
    useState(false);

  const [retryError, setRetryError] =
    useState<string | null>(null);

  const resolved = resolveError(error);

  const effectiveTitle =
    title?.trim() || resolved.title;

  const effectiveMessage =
    message?.trim() || resolved.message;

  const effectiveSeverity =
    severity ?? resolved.severity;

  const retrying =
    isRetrying || internalRetrying;

  const isCompact =
    variant === "inline" ||
    variant === "banner";

  const canRetry =
    Boolean(onRetry) &&
    showRetry &&
    resolved.retryable;

  const handleRetry = async (): Promise<void> => {
    if (!onRetry || retrying) {
      return;
    }

    setRetryError(null);
    setInternalRetrying(true);

    try {
      await onRetry();
    } catch (retryFailure) {
      setRetryError(
        getApiErrorMessage(retryFailure),
      );
    } finally {
      setInternalRetrying(false);
    }
  };

  const containerClasses = joinClasses(
    VARIANT_CLASSES[variant],
    effectiveSeverity === "warning" &&
      isCompact &&
      "border-warning/25 bg-warning/5",
    className,
  );

  const content = (
    <>
      {showIcon && (
        <div
          className={joinClasses(
            "flex shrink-0 items-center justify-center",
            !isCompact &&
              "mb-1 h-12 w-12 rounded-full",
            !isCompact &&
              (
                effectiveSeverity === "warning"
                  ? "bg-warning/10"
                  : "bg-error/10"
              ),
          )}
        >
          <ErrorIcon
            icon={resolved.icon}
            severity={effectiveSeverity}
            size={isCompact ? 20 : 26}
          />
        </div>
      )}

      <div
        className={joinClasses(
          "min-w-0",
          isCompact
            ? "flex-1"
            : "flex w-full max-w-lg flex-col items-center",
        )}
      >
        <h2
          id={titleId}
          className={joinClasses(
            "font-semibold text-text-primary",
            isCompact
              ? "text-sm"
              : "text-lg",
          )}
        >
          {effectiveTitle}
        </h2>

        <p
          id={messageId}
          className={joinClasses(
            "mt-1 text-sm leading-relaxed text-text-muted",
            !isCompact && "max-w-md",
          )}
        >
          {effectiveMessage}
        </p>

        {description?.trim() && (
          <p className="mt-2 text-sm leading-relaxed text-text-muted">
            {description}
          </p>
        )}

        {children && (
          <div className="mt-3 w-full text-sm text-text-muted">
            {children}
          </div>
        )}

        {retryError && (
          <p
            role="alert"
            className="mt-3 text-sm text-error"
          >
            {retryError}
          </p>
        )}

        {(canRetry || onDismiss) && (
          <div
            className={joinClasses(
              "mt-4 flex flex-wrap gap-2",
              !isCompact &&
                "justify-center",
            )}
          >
            {canRetry && (
              <button
                type="button"
                className="app-button app-button-primary inline-flex items-center justify-center gap-2"
                onClick={() => {
                  void handleRetry();
                }}
                disabled={retrying}
                aria-busy={retrying}
              >
                <RefreshCw
                  size={16}
                  aria-hidden="true"
                  className={
                    retrying
                      ? "motion-safe:animate-spin"
                      : ""
                  }
                />

                <span>
                  {retrying
                    ? "Retrying..."
                    : retryLabel}
                </span>
              </button>
            )}

            {onDismiss && (
              <button
                type="button"
                className="app-button app-button-secondary inline-flex items-center justify-center gap-2"
                onClick={onDismiss}
                disabled={retrying}
              >
                <XCircle
                  size={16}
                  aria-hidden="true"
                />

                {dismissLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      className={containerClasses}
      style={getMinHeightStyle(minHeight)}
      data-testid={testId}
      data-error-variant={variant}
      data-error-severity={effectiveSeverity}
    >
      {content}
    </div>
  );
}

export type ErrorBannerProps = Omit<ErrorStateProps, "variant">;

export function ErrorBanner(
  props: ErrorBannerProps,
) {
  return (
    <ErrorState
      {...props}
      variant="banner"
    />
  );
}

export interface InlineErrorProps {
  message: string;
  className?: string;
  testId?: string;
}

export function InlineError({
  message,
  className,
  testId,
}: InlineErrorProps) {
  if (!message.trim()) {
    return null;
  }

  return (
    <p
      role="alert"
      className={joinClasses(
        "flex items-start gap-2 text-sm text-error",
        className,
      )}
      data-testid={testId}
    >
      <AlertCircle
        size={16}
        className="mt-0.5 shrink-0"
        aria-hidden="true"
      />

      <span>{message}</span>
    </p>
  );
}

export default ErrorState;
