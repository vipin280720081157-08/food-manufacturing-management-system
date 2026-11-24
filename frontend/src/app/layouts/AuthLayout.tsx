import { useId, type ReactNode } from "react";
import { Outlet } from "react-router-dom";

import {
  Factory,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";

export interface AuthLayoutProps {
  children?: ReactNode;
  title?: string;
  subtitle?: string;
  showBranding?: boolean;
  className?: string;
  testId?: string;
}

function joinClasses(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Responsive layout for unauthenticated application screens.
 * Authentication and session management remain in AuthProvider.
 */
export function AuthLayout({
  children,
  title = "Food Manufacturing Management System",
  subtitle = "Secure operations management",
  showBranding = true,
  className,
  testId,
}: AuthLayoutProps) {
  const generatedId = useId();

  const titleId = `${generatedId}-title`;
  const subtitleId = `${generatedId}-subtitle`;

  return (
    <div
      className={joinClasses(
        "relative flex min-h-screen min-h-dvh flex-col",
        "bg-background font-sans text-text-primary",
        className,
      )}
      data-testid={testId}
    >
      <a
        href="#auth-main-content"
        className="app-skip-link"
      >
        Skip to main content
      </a>

      {showBranding && (
        <header className="relative z-10 border-b border-border/80 bg-surface/90">
          <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-4 sm:px-6 lg:px-8">
            <span
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-primary text-white"
              aria-hidden="true"
            >
              <Factory
                size={25}
                strokeWidth={1.8}
              />
            </span>

            <div className="min-w-0">
              <p className="truncate text-sm font-bold leading-5 text-text-primary sm:text-base">
                Food Manufacturing
              </p>

              <p className="truncate text-xs font-medium text-text-muted">
                Management System
              </p>
            </div>
          </div>
        </header>
      )}

      <main
        id="auth-main-content"
        className="relative flex w-full flex-1 items-center justify-center px-4 py-10 sm:px-6 sm:py-14 lg:px-8"
      >
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div
            className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-primary/5 blur-3xl sm:h-96 sm:w-96"
            aria-hidden="true"
          />

          <div
            className="absolute -bottom-32 -left-24 h-72 w-72 rounded-full bg-accent/5 blur-3xl sm:h-96 sm:w-96"
            aria-hidden="true"
          />
        </div>

        <div className="relative z-10 grid w-full max-w-5xl overflow-hidden rounded-card border border-border bg-surface shadow-card lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          {showBranding && (
            <section
              className="relative hidden min-h-[32rem] flex-col justify-between overflow-hidden bg-primary px-10 py-12 text-white lg:flex"
              aria-labelledby={titleId}
              aria-describedby={subtitleId}
            >
              <div
                className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full border border-white/10"
                aria-hidden="true"
              />

              <div
                className="pointer-events-none absolute -bottom-32 -left-24 h-80 w-80 rounded-full border border-white/10"
                aria-hidden="true"
              />

              <div className="relative z-10">
                <div className="mb-10 flex h-14 w-14 items-center justify-center rounded-xl border border-white/20 bg-white/10">
                  <Factory
                    size={30}
                    strokeWidth={1.7}
                    aria-hidden="true"
                  />
                </div>

                <h1
                  id={titleId}
                  className="max-w-sm text-3xl font-bold leading-tight tracking-tight"
                >
                  {title}
                </h1>

                <p
                  id={subtitleId}
                  className="mt-5 max-w-sm text-base leading-7 text-white/80"
                >
                  {subtitle}
                </p>
              </div>

              <div className="relative z-10 space-y-5">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-white/10">
                    <ShieldCheck
                      size={19}
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                  </span>

                  <div>
                    <p className="text-sm font-semibold">
                      Role-based access
                    </p>

                    <p className="mt-1 text-xs leading-5 text-white/75">
                      Access to operational workflows is
                      determined by assigned permissions.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-white/10">
                    <LockKeyhole
                      size={19}
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                  </span>

                  <div>
                    <p className="text-sm font-semibold">
                      Protected business records
                    </p>

                    <p className="mt-1 text-xs leading-5 text-white/75">
                      Business transactions are validated
                      and authorized by the backend.
                    </p>
                  </div>
                </div>
              </div>
            </section>
          )}

          <section
            className={joinClasses(
              "flex min-w-0 flex-col justify-center",
              "px-5 py-8 sm:px-10 sm:py-12",
              "lg:px-12 lg:py-14",
              !showBranding &&
                "lg:col-span-2 lg:mx-auto lg:w-full lg:max-w-xl",
            )}
            aria-label="Authentication"
          >
            {showBranding && (
              <div className="mb-8 lg:hidden">
                <span
                  className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-control bg-primary/10 text-primary"
                  aria-hidden="true"
                >
                  <Factory
                    size={25}
                    strokeWidth={1.8}
                  />
                </span>

                <h1 className="text-xl font-bold leading-7 text-text-primary sm:text-2xl">
                  {title}
                </h1>

                <p className="mt-2 text-sm leading-6 text-text-muted">
                  {subtitle}
                </p>
              </div>
            )}

            <div className="w-full min-w-0">
              {children ?? <Outlet />}
            </div>
          </section>
        </div>
      </main>

      <footer className="relative z-10 border-t border-border/80 bg-surface/80 px-4 py-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-2 text-center text-xs text-text-muted sm:flex-row sm:text-left">
          <p>
            Food Manufacturing Management System
          </p>

          <p className="inline-flex items-center gap-1.5">
            <LockKeyhole
              size={13}
              aria-hidden="true"
            />

            Authorized access only
          </p>
        </div>
      </footer>
    </div>
  );
}

export default AuthLayout;