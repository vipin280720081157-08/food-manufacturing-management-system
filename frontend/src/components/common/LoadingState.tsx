import {
  useId,
  type CSSProperties,
  type ReactNode,
} from "react";

export type LoadingStateVariant =
  | "page"
  | "section"
  | "inline"
  | "overlay";

export type LoadingStateSize =
  | "sm"
  | "md"
  | "lg";

export interface LoadingStateProps {
  message?: string;
  description?: string;
  variant?: LoadingStateVariant;
  size?: LoadingStateSize;
  className?: string;
  spinnerClassName?: string;
  children?: ReactNode;
  fullScreen?: boolean;
  showSpinner?: boolean;
  showMessage?: boolean;
  minHeight?: number | string;
  testId?: string;
}

const SPINNER_SIZE_CLASSES: Record<
  LoadingStateSize,
  string
> = {
  sm: "h-4 w-4 border-2",
  md: "h-7 w-7 border-[3px]",
  lg: "h-10 w-10 border-4",
};

const MESSAGE_SIZE_CLASSES: Record<
  LoadingStateSize,
  string
> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
};

const VARIANT_CLASSES: Record<
  LoadingStateVariant,
  string
> = {
  page: [
    "flex w-full flex-col items-center",
    "justify-center gap-4",
    "px-4 py-12 text-center",
  ].join(" "),

  section: [
    "flex w-full flex-col items-center",
    "justify-center gap-3",
    "rounded-card border border-border",
    "bg-surface px-4 py-8 text-center",
  ].join(" "),

  inline: [
    "inline-flex items-center",
    "justify-center gap-2",
  ].join(" "),

  overlay: [
    "absolute inset-0 z-30",
    "flex flex-col items-center",
    "justify-center gap-3",
    "bg-surface/90 px-4 text-center",
    "backdrop-blur-[2px]",
  ].join(" "),
};

function joinClasses(
  ...classes: Array<
    string | false | null | undefined
  >
): string {
  return classes
    .filter(Boolean)
    .join(" ");
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

/**
 * Accessible loading indicator for pages, sections,
 * inline actions, and content overlays.
 */
export function LoadingState({
  message = "Loading...",
  description,
  variant = "section",
  size = "md",
  className,
  spinnerClassName,
  children,
  fullScreen = false,
  showSpinner = true,
  showMessage = true,
  minHeight,
  testId,
}: LoadingStateProps) {
  const descriptionId = useId();

  const isInline =
    variant === "inline";

  const isOverlay =
    variant === "overlay";

  const containerClasses = joinClasses(
    VARIANT_CLASSES[variant],

    fullScreen &&
      !isOverlay &&
      "min-h-dvh",

    isOverlay &&
      fullScreen &&
      "fixed",

    className,
  );

  const spinnerClasses = joinClasses(
    "app-loading-spinner",
    "inline-block shrink-0 rounded-full",
    "border-primary/20 border-t-primary",
    "motion-safe:animate-spin",
    "motion-reduce:animate-none",
    SPINNER_SIZE_CLASSES[size],
    spinnerClassName,
  );

  const hasDescription =
    Boolean(description?.trim());

  const hasMessage =
    showMessage &&
    Boolean(message.trim());

  const accessibleMessage =
    message.trim() || "Loading";

  const content = (
    <>
      {showSpinner && (
        <span
          aria-hidden="true"
          className={spinnerClasses}
        />
      )}

      {(hasMessage ||
        hasDescription ||
        children) && (
        <div
          className={joinClasses(
            "flex min-w-0 flex-col",
            isInline
              ? "items-start gap-0.5 text-left"
              : "items-center gap-1 text-center",
          )}
        >
          {hasMessage && (
            <p
              className={joinClasses(
                "font-medium text-text-primary",
                MESSAGE_SIZE_CLASSES[size],
              )}
            >
              {message}
            </p>
          )}

          {hasDescription && (
            <p
              id={descriptionId}
              className="max-w-md text-sm text-text-muted"
            >
              {description}
            </p>
          )}

          {children && (
            <div className="mt-1 text-sm text-text-muted">
              {children}
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={accessibleMessage}
      aria-describedby={
        hasDescription
          ? descriptionId
          : undefined
      }
      aria-busy="true"
      className={containerClasses}
      style={getMinHeightStyle(
        minHeight,
      )}
      data-testid={testId}
      data-loading-variant={variant}
    >
      {content}

      {!hasMessage && (
        <span className="app-sr-only">
          {accessibleMessage}
        </span>
      )}
    </div>
  );
}

export interface LoadingOverlayProps
  extends Omit<
    LoadingStateProps,
    "variant"
  > {
  active: boolean;
}

export function LoadingOverlay({
  active,
  children,
  ...props
}: LoadingOverlayProps) {
  if (!active) {
    return null;
  }

  return (
    <LoadingState
      {...props}
      variant="overlay"
    >
      {children}
    </LoadingState>
  );
}

export interface LoadingButtonContentProps {
  loading: boolean;
  loadingText?: string;
  children: ReactNode;
  size?: LoadingStateSize;
}

export function LoadingButtonContent({
  loading,
  loadingText = "Processing...",
  children,
  size = "sm",
}: LoadingButtonContentProps) {
  if (!loading) {
    return <>{children}</>;
  }

  return (
    <span className="inline-flex items-center justify-center gap-2">
      <span
        aria-hidden="true"
        className={joinClasses(
          "app-loading-spinner",
          "inline-block shrink-0 rounded-full",
          "border-current/25 border-t-current",
          "motion-safe:animate-spin",
          "motion-reduce:animate-none",
          SPINNER_SIZE_CLASSES[size],
        )}
      />

      <span
        role="status"
        aria-live="polite"
      >
        {loadingText}
      </span>
    </span>
  );
}

export default LoadingState;