import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { createPortal } from "react-dom";

import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  LoaderCircle,
  X,
} from "lucide-react";

import {
  getApiErrorMessage,
} from "../../services/api/client";

export type ConfirmDialogVariant =
  | "default"
  | "danger"
  | "warning";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: string;
  description?: string;
  variant?: ConfirmDialogVariant;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  requireConfirmationText?: string;
  confirmationPlaceholder?: string;
  children?: ReactNode;
  className?: string;
  testId?: string;
}

const VARIANT_STYLES: Record<
  ConfirmDialogVariant,
  {
    icon: string;
    background: string;
    button: string;
  }
> = {
  default: {
    icon: "text-accent",
    background: "bg-accent/10",
    button:
      "bg-primary text-white hover:bg-secondary",
  },
  danger: {
    icon: "text-error",
    background: "bg-error/10",
    button:
      "bg-error text-white hover:bg-error/90",
  },
  warning: {
    icon: "text-warning",
    background: "bg-warning/10",
    button:
      "bg-warning text-white hover:bg-warning/90",
  },
};

function joinClasses(
  ...classes: Array<
    string | false | null | undefined
  >
): string {
  return classes.filter(Boolean).join(" ");
}

function DialogIcon({
  variant,
}: {
  variant: ConfirmDialogVariant;
}) {
  const iconProps = {
    size: 24,
    strokeWidth: 1.8,
    "aria-hidden": true as const,
  };

  switch (variant) {
    case "danger":
    case "warning":
      return <AlertTriangle {...iconProps} />;

    case "default":
    default:
      return <HelpCircle {...iconProps} />;
  }
}

/**
 * Accessible confirmation dialog for operations requiring
 * explicit approval before invoking backend mutations.
 *
 * The dialog closes after successful confirmation only.
 * Failed operations retain the dialog and display the error.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  description,
  variant = "default",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  isLoading = false,
  disabled = false,
  requireConfirmationText,
  confirmationPlaceholder,
  children,
  className,
  testId,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const confirmationInputId = useId();
  const errorId = useId();

  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef =
    useRef<HTMLButtonElement>(null);
  const previousFocusRef =
    useRef<HTMLElement | null>(null);
  const submittingRef = useRef(false);

  const [confirmationText, setConfirmationText] =
    useState("");

  const [internalLoading, setInternalLoading] =
    useState(false);

  const [error, setError] =
    useState<string | null>(null);

  const busy = isLoading || internalLoading;

  const requiresText =
    typeof requireConfirmationText === "string" &&
    requireConfirmationText.length > 0;

  const confirmationMatches =
    !requiresText ||
    confirmationText === requireConfirmationText;

  const canConfirm =
    !busy &&
    !disabled &&
    confirmationMatches;

  const styles = VARIANT_STYLES[variant];

  const handleCancel = useCallback((): void => {
    if (busy) {
      return;
    }

    onCancel();
  }, [busy, onCancel]);

  const handleConfirm = async (): Promise<void> => {
    if (!canConfirm || submittingRef.current) {
      return;
    }

    submittingRef.current = true;
    setInternalLoading(true);
    setError(null);

    try {
      await onConfirm();
    } catch (failure) {
      setError(getApiErrorMessage(failure));
    } finally {
      submittingRef.current = false;
      setInternalLoading(false);
    }
  };

  useEffect(() => {
    if (!open) {
      setConfirmationText("");
      setError(null);
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const previousOverflow =
      document.body.style.overflow;

    document.body.style.overflow = "hidden";

    const focusFrame = window.requestAnimationFrame(
      () => {
        cancelButtonRef.current?.focus();
      },
    );

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow =
        previousOverflow;

      previousFocusRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (
      event: KeyboardEvent,
    ): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();

        handleCancel();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const dialog = dialogRef.current;

      if (!dialog) {
        return;
      }

      const focusableElements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          [
            "button:not([disabled])",
            "input:not([disabled])",
            "select:not([disabled])",
            "textarea:not([disabled])",
            "a[href]",
            '[tabindex]:not([tabindex="-1"])',
          ].join(","),
        ),
      ).filter(
        (element) =>
          element.getClientRects().length > 0,
      );

      if (focusableElements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusableElements[0];
      const last =
        focusableElements[
          focusableElements.length - 1
        ];

      if (!first || !last) {
        return;
      }

      const activeElement =
        document.activeElement;

      if (
        event.shiftKey &&
        (
          activeElement === first ||
          !dialog.contains(activeElement)
        )
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (
          activeElement === last ||
          !dialog.contains(activeElement)
        )
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener(
      "keydown",
      handleKeyDown,
      true,
    );

    return () => {
      document.removeEventListener(
        "keydown",
        handleKeyDown,
        true,
      );
    };
  }, [open, handleCancel]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  const hasDescription =
    Boolean(message?.trim()) ||
    Boolean(description?.trim());

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-text-primary/60 px-4 py-6 backdrop-blur-[2px]"
      data-testid={testId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          handleCancel();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={
          hasDescription
            ? descriptionId
            : undefined
        }
        aria-busy={busy}
        tabIndex={-1}
        className={joinClasses(
          "relative w-full max-w-md",
          "rounded-card border border-border",
          "bg-surface shadow-xl",
          "outline-none",
          "max-h-[calc(100dvh-3rem)] overflow-y-auto",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={joinClasses(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                styles.background,
                styles.icon,
              )}
              aria-hidden="true"
            >
              <DialogIcon variant={variant} />
            </span>

            <div className="min-w-0 pt-1">
              <h2
                id={titleId}
                className="text-base font-semibold leading-6 text-text-primary sm:text-lg"
              >
                {title}
              </h2>
            </div>
          </div>

          <button
            type="button"
            onClick={handleCancel}
            disabled={busy}
            aria-label="Close dialog"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-text-muted transition-colors hover:bg-background hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X
              size={18}
              aria-hidden="true"
            />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5 sm:px-6">
          {hasDescription && (
            <div
              id={descriptionId}
              className="space-y-2 text-sm leading-6 text-text-muted"
            >
              {message?.trim() && (
                <p>{message}</p>
              )}

              {description?.trim() && (
                <p>{description}</p>
              )}
            </div>
          )}

          {children}

          {requiresText && (
            <div className="space-y-2">
              <label
                htmlFor={confirmationInputId}
                className="app-field-label block"
              >
                Enter{" "}
                <span className="font-semibold text-text-primary">
                  {requireConfirmationText}
                </span>{" "}
                to confirm
              </label>

              <input
                id={confirmationInputId}
                type="text"
                value={confirmationText}
                onChange={(event) => {
                  setConfirmationText(
                    event.target.value,
                  );
                }}
                placeholder={
                  confirmationPlaceholder ??
                  "Confirmation text"
                }
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-invalid={
                  confirmationText.length > 0 &&
                  !confirmationMatches
                }
                className="app-input w-full"
              />
            </div>
          )}

          {error && (
            <div
              id={errorId}
              role="alert"
              className="app-alert app-alert-error flex items-start gap-2"
            >
              <AlertTriangle
                size={18}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />

              <p className="text-sm">
                {error}
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-3 border-t border-border bg-background/40 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={handleCancel}
            disabled={busy}
            className="app-button app-button-secondary inline-flex min-h-10 items-center justify-center"
          >
            {cancelLabel}
          </button>

          <button
            type="button"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={!canConfirm}
            aria-busy={busy}
            aria-describedby={
              error ? errorId : undefined
            }
            className={joinClasses(
              "app-button inline-flex min-h-10 items-center justify-center gap-2",
              "font-medium transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              "disabled:cursor-not-allowed disabled:opacity-50",
              styles.button,
            )}
          >
            {busy ? (
              <LoaderCircle
                size={17}
                className="motion-safe:animate-spin"
                aria-hidden="true"
              />
            ) : variant === "default" ? (
              <CheckCircle2
                size={17}
                aria-hidden="true"
              />
            ) : (
              <AlertTriangle
                size={17}
                aria-hidden="true"
              />
            )}

            <span>
              {busy
                ? "Processing..."
                : confirmLabel}
            </span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default ConfirmDialog;