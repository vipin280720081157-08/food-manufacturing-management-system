import {
  useEffect,
  useRef,
  type ComponentType,
  type ReactNode,
} from "react";

import {
  NavLink,
  useLocation,
} from "react-router-dom";

import {
  BarChart3,
  BookOpen,
  Boxes,
  ClipboardCheck,
  ClipboardList,
  CloudOff,
  Factory,
  FileCheck2,
  FileText,
  LayoutDashboard,
  Package,
  PackageCheck,
  PackageOpen,
  Receipt,
  ShoppingCart,
  Truck,
  Users,
  UserRoundCog,
  Wallet,
  Warehouse,
  X,
  type LucideProps,
} from "lucide-react";

import {
  USER_ROLES,
  type UserRole,
} from "../../types/auth";

import { useAuth } from "../../hooks/useAuth";

export interface AppSidebarProps {
  open?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  className?: string;
  header?: ReactNode;
  footer?: ReactNode;
  testId?: string;
}

export interface SidebarNavigationItem {
  label: string;
  path: string;
  icon: ComponentType<LucideProps>;
  roles: readonly UserRole[];
  end?: boolean;
}

export interface SidebarNavigationGroup {
  label: string;
  items: readonly SidebarNavigationItem[];
}

const ALL_ROLES: readonly UserRole[] = [
  USER_ROLES.SALESMAN,
  USER_ROLES.FACTORY_ADMIN,
  USER_ROLES.PRODUCTION_SUPERVISOR,
  USER_ROLES.ACCOUNTANT_AUDITOR,
  USER_ROLES.OWNER,
];

const ADMIN_AND_READ_ONLY: readonly UserRole[] = [
  USER_ROLES.FACTORY_ADMIN,
  USER_ROLES.ACCOUNTANT_AUDITOR,
  USER_ROLES.OWNER,
];

const PRODUCTION_ROLES: readonly UserRole[] = [
  USER_ROLES.FACTORY_ADMIN,
  USER_ROLES.PRODUCTION_SUPERVISOR,
  USER_ROLES.ACCOUNTANT_AUDITOR,
  USER_ROLES.OWNER,
];

const SALES_ROLES: readonly UserRole[] = [
  USER_ROLES.SALESMAN,
  USER_ROLES.FACTORY_ADMIN,
  USER_ROLES.ACCOUNTANT_AUDITOR,
  USER_ROLES.OWNER,
];

export const SIDEBAR_NAVIGATION: readonly SidebarNavigationGroup[] = [
  {
    label: "Overview",
    items: [
      {
        label: "Dashboard",
        path: "/dashboard",
        icon: LayoutDashboard,
        roles: ALL_ROLES,
      },
    ],
  },
  {
    label: "Master Data",
    items: [
      {
        label: "Customers",
        path: "/customers",
        icon: Users,
        roles: SALES_ROLES,
      },
      {
        label: "Suppliers",
        path: "/suppliers",
        icon: Warehouse,
        roles: ADMIN_AND_READ_ONLY,
      },
      {
        label: "Products",
        path: "/products",
        icon: Package,
        roles: ALL_ROLES,
      },
      {
        label: "Price Lists",
        path: "/price-lists",
        icon: Receipt,
        roles: SALES_ROLES,
      },
      {
        label: "Users",
        path: "/users",
        icon: UserRoundCog,
        roles: [
          USER_ROLES.FACTORY_ADMIN,
          USER_ROLES.OWNER,
        ],
      },
    ],
  },
  {
    label: "Purchasing",
    items: [
      {
        label: "Purchase Orders",
        path: "/purchases",
        icon: ShoppingCart,
        roles: ADMIN_AND_READ_ONLY,
      },
      {
        label: "Goods Receipts",
        path: "/goods-receipts",
        icon: PackageCheck,
        roles: ADMIN_AND_READ_ONLY,
      },
    ],
  },
  {
    label: "Inventory",
    items: [
      {
        label: "Stock Summary",
        path: "/inventory",
        icon: Boxes,
        roles: PRODUCTION_ROLES,
        end: true,
      },
      {
        label: "Stock Batches",
        path: "/inventory/batches",
        icon: PackageOpen,
        roles: PRODUCTION_ROLES,
      },
      {
        label: "Stock Ledger",
        path: "/inventory/ledger",
        icon: BookOpen,
        roles: PRODUCTION_ROLES,
      },
      {
        label: "Stock Adjustments",
        path: "/inventory/adjustments",
        icon: ClipboardCheck,
        roles: [
          USER_ROLES.FACTORY_ADMIN,
          USER_ROLES.ACCOUNTANT_AUDITOR,
          USER_ROLES.OWNER,
        ],
      },
    ],
  },
  {
    label: "Production",
    items: [
      {
        label: "Bill of Materials",
        path: "/production/bom",
        icon: ClipboardList,
        roles: PRODUCTION_ROLES,
      },
      {
        label: "Production Runs",
        path: "/production/runs",
        icon: Factory,
        roles: PRODUCTION_ROLES,
      },
      {
        label: "Production Costing",
        path: "/production/costing",
        icon: BarChart3,
        roles: PRODUCTION_ROLES,
      },
    ],
  },
  {
    label: "Sales",
    items: [
      {
        label: "Sales Orders",
        path: "/sales/orders",
        icon: ShoppingCart,
        roles: SALES_ROLES,
      },
      {
        label: "Create Order",
        path: "/sales/orders/new",
        icon: ClipboardList,
        roles: [
          USER_ROLES.SALESMAN,
          USER_ROLES.FACTORY_ADMIN,
        ],
      },
      {
        label: "Order Review",
        path: "/sales/review",
        icon: ClipboardCheck,
        roles: ADMIN_AND_READ_ONLY,
      },
      {
        label: "Offline Orders",
        path: "/offline-orders",
        icon: CloudOff,
        roles: [USER_ROLES.SALESMAN],
      },
    ],
  },
  {
    label: "Invoicing & Dispatch",
    items: [
      {
        label: "GST Invoices",
        path: "/invoices",
        icon: FileText,
        roles: ADMIN_AND_READ_ONLY,
      },
      {
        label: "Dispatch",
        path: "/dispatch",
        icon: Truck,
        roles: ADMIN_AND_READ_ONLY,
      },
    ],
  },
  {
    label: "Finance",
    items: [
      {
        label: "Payments",
        path: "/payments",
        icon: Wallet,
        roles: ADMIN_AND_READ_ONLY,
      },
      {
        label: "Outstanding",
        path: "/outstanding",
        icon: Receipt,
        roles: ADMIN_AND_READ_ONLY,
      },
    ],
  },
  {
    label: "Reports & Compliance",
    items: [
      {
        label: "Reports",
        path: "/reports",
        icon: BarChart3,
        roles: ADMIN_AND_READ_ONLY,
      },
      {
        label: "Government Documents",
        path: "/government-documents",
        icon: FileCheck2,
        roles: ADMIN_AND_READ_ONLY,
      },
    ],
  },
];

function joinClasses(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

function getVisibleGroups(
  role: UserRole | null,
): SidebarNavigationGroup[] {
  if (!role) {
    return [];
  }

  return SIDEBAR_NAVIGATION.map((group) => ({
    label: group.label,
    items: group.items.filter((item) =>
      item.roles.includes(role),
    ),
  })).filter((group) => group.items.length > 0);
}

function isNavigationItemActive(
  pathname: string,
  item: SidebarNavigationItem,
): boolean {
  if (item.end) {
    return pathname === item.path;
  }

  return (
    pathname === item.path ||
    pathname.startsWith(`${item.path}/`)
  );
}

interface SidebarLinkProps {
  item: SidebarNavigationItem;
  collapsed: boolean;
  onNavigate?: () => void;
}

function SidebarLink({
  item,
  collapsed,
  onNavigate,
}: SidebarLinkProps) {
  const Icon = item.icon;

  return (
    <NavLink
      to={item.path}
      end={item.end}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        joinClasses(
          "group flex min-h-10 items-center gap-3",
          "rounded-control px-3 py-2.5",
          "text-sm font-medium transition-colors",
          "focus-visible:outline-2",
          "focus-visible:outline-offset-2",
          "focus-visible:outline-accent",
          isActive
            ? "bg-accent/10 text-accent"
            : "text-secondary hover:bg-background hover:text-text-primary",
          collapsed && "justify-center px-2",
        )
      }
    >
      <Icon
        size={19}
        strokeWidth={1.9}
        className="shrink-0"
        aria-hidden="true"
      />

      {collapsed ? (
        <span className="app-sr-only">
          {item.label}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">
          {item.label}
        </span>
      )}
    </NavLink>
  );
}

interface SidebarContentProps {
  collapsed: boolean;
  onNavigate?: () => void;
  header?: ReactNode;
  footer?: ReactNode;
}

function SidebarContent({
  collapsed,
  onNavigate,
  header,
  footer,
}: SidebarContentProps) {
  const { user, isAuthenticated } = useAuth();
  const location = useLocation();

  const role =
    isAuthenticated && user
      ? user.role
      : null;

  const groups = getVisibleGroups(role);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div
        className={joinClasses(
          "flex min-h-16 shrink-0 items-center",
          "border-b border-border px-4 py-3",
          collapsed && "justify-center px-2",
        )}
      >
        {header ?? (
          <NavLink
            to="/dashboard"
            onClick={onNavigate}
            aria-label="Food Manufacturing Management System dashboard"
            className={joinClasses(
              "flex min-w-0 items-center gap-3",
              "rounded-control",
              "focus-visible:outline-2",
              "focus-visible:outline-offset-2",
              "focus-visible:outline-accent",
            )}
          >
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control bg-primary text-white"
              aria-hidden="true"
            >
              <Factory size={23} strokeWidth={1.8} />
            </span>

            {!collapsed && (
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold leading-5 text-text-primary">
                  Food Manufacturing
                </span>

                <span className="block truncate text-xs font-medium text-text-muted">
                  Management System
                </span>
              </span>
            )}
          </NavLink>
        )}
      </div>

      <nav
        aria-label="Main navigation"
        className={joinClasses(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain",
          "px-3 py-4",
          collapsed && "px-2",
        )}
      >
        <div className="space-y-5">
          {groups.map((group) => (
            <section
              key={group.label}
              aria-label={group.label}
            >
              {!collapsed && (
                <h2 className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  {group.label}
                </h2>
              )}

              {collapsed && (
                <span className="app-sr-only">
                  {group.label}
                </span>
              )}

              <div className="space-y-1">
                {group.items.map((item) => (
                  <SidebarLink
                    key={item.path}
                    item={item}
                    collapsed={collapsed}
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </nav>

      <div
        className={joinClasses(
          "shrink-0 border-t border-border",
          "px-4 py-3",
          collapsed && "px-2",
        )}
      >
        {footer ?? (
          <div
            className={joinClasses(
              "flex items-center gap-2",
              collapsed && "justify-center",
            )}
          >
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-background text-secondary"
              aria-hidden="true"
            >
              <Package size={17} />
            </span>

            {!collapsed && (
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-text-primary">
                  FMMS
                </p>

                <p className="truncate text-[11px] text-text-muted">
                  Operations workspace
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <span
        className="app-sr-only"
        aria-live="polite"
      >
        {groups
          .flatMap((group) => group.items)
          .find((item) =>
            isNavigationItemActive(
              location.pathname,
              item,
            ),
          )?.label ?? ""}
      </span>
    </div>
  );
}

/**
 * Responsive, role-filtered application navigation.
 * Visibility is presentational; backend permissions remain authoritative.
 */
export function AppSidebar({
  open = false,
  onClose,
  collapsed = false,
  className,
  header,
  footer,
  testId,
}: AppSidebarProps) {
  const location = useLocation();

  const previousPathRef = useRef(
    location.pathname,
  );

  const mobilePanelRef =
    useRef<HTMLElement>(null);

  const closeButtonRef =
    useRef<HTMLButtonElement>(null);

  const previousFocusRef =
    useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (
      previousPathRef.current !==
      location.pathname
    ) {
      previousPathRef.current =
        location.pathname;

      if (open) {
        onClose?.();
      }
    }
  }, [
    location.pathname,
    open,
    onClose,
  ]);

  useEffect(() => {
    if (!open) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const previousOverflow =
      document.body.style.overflow;

    document.body.style.overflow = "hidden";

    const frame = window.requestAnimationFrame(
      () => {
        closeButtonRef.current?.focus();
      },
    );

    const handleKeyDown = (
      event: KeyboardEvent,
    ): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const panel = mobilePanelRef.current;

      if (!panel) {
        return;
      }

      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          [
            "a[href]",
            "button:not([disabled])",
            "input:not([disabled])",
            "select:not([disabled])",
            "textarea:not([disabled])",
            '[tabindex]:not([tabindex="-1"])',
          ].join(","),
        ),
      ).filter(
        (element) =>
          element.getClientRects().length > 0,
      );

      const first = focusable[0];
      const last =
        focusable[focusable.length - 1];

      if (!first || !last) {
        event.preventDefault();
        panel.focus();
        return;
      }

      if (
        event.shiftKey &&
        document.activeElement === first
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === last
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener(
      "keydown",
      handleKeyDown,
    );

    return () => {
      window.cancelAnimationFrame(frame);

      document.body.style.overflow =
        previousOverflow;

      document.removeEventListener(
        "keydown",
        handleKeyDown,
      );

      previousFocusRef.current?.focus();
    };
  }, [open, onClose]);

  return (
    <>
      <aside
        id="app-sidebar"
        className={joinClasses(
          "hidden h-full shrink-0",
          "border-r border-border bg-surface",
          "lg:block",
          collapsed ? "w-20" : "w-64",
          className,
        )}
        aria-label="Application sidebar"
        data-testid={testId}
      >
        <SidebarContent
          collapsed={collapsed}
          header={header}
          footer={footer}
        />
      </aside>

      {open && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          role="presentation"
        >
          <div
            className="absolute inset-0 bg-text-primary/60"
            onClick={onClose}
            aria-hidden="true"
          />

          <aside
            ref={mobilePanelRef}
            id="app-sidebar-mobile"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            tabIndex={-1}
            className={joinClasses(
              "absolute inset-y-0 left-0",
              "flex w-[min(18rem,85vw)] flex-col",
              "bg-surface shadow-xl",
              "outline-none",
            )}
          >
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Close navigation menu"
              className={joinClasses(
                "absolute right-3 top-4 z-10",
                "flex h-9 w-9 items-center justify-center",
                "rounded-control bg-background text-secondary",
                "hover:text-text-primary",
                "focus-visible:outline-2",
                "focus-visible:outline-offset-2",
                "focus-visible:outline-accent",
              )}
            >
              <X
                size={19}
                aria-hidden="true"
              />
            </button>

            <SidebarContent
              collapsed={false}
              onNavigate={onClose}
              header={header}
              footer={footer}
            />
          </aside>
        </div>
      )}
    </>
  );
}

export default AppSidebar;