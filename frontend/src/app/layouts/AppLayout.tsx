import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import {
  Outlet,
  useLocation,
} from "react-router-dom";

import {
  AppHeader,
} from "../../components/common/AppHeader";

import {
  AppSidebar,
} from "../../components/common/AppSidebar";

import {
  useAuth,
} from "../../hooks/useAuth";

import {
  USER_ROLE_LABELS,
} from "../../types/auth";

export interface AppLayoutProps {
  children?: ReactNode;
  title?: string;
  subtitle?: string;
  headerActions?: ReactNode;
  sidebarCollapsed?: boolean;
  className?: string;
  contentClassName?: string;
  testId?: string;
}

interface PageMetadata {
  title: string;
  subtitle?: string;
}

const PAGE_METADATA: Record<string, PageMetadata> = {
  "/dashboard": {
    title: "Dashboard",
    subtitle: "Operational overview",
  },
  "/customers": {
    title: "Customers",
    subtitle: "Customer records and account information",
  },
  "/suppliers": {
    title: "Suppliers",
    subtitle: "Supplier records and contact information",
  },
  "/products": {
    title: "Products",
    subtitle: "Product and inventory item information",
  },
  "/price-lists": {
    title: "Price Lists",
    subtitle: "Product selling prices",
  },
  "/users": {
    title: "Users",
    subtitle: "User accounts and assigned roles",
  },
  "/purchases": {
    title: "Purchase Orders",
    subtitle: "Purchasing records and order management",
  },
  "/goods-receipts": {
    title: "Goods Receipts",
    subtitle: "Received materials and stock receipts",
  },
  "/inventory": {
    title: "Stock Summary",
    subtitle: "Inventory availability and stock balances",
  },
  "/inventory/batches": {
    title: "Stock Batches",
    subtitle: "Batch-level inventory information",
  },
  "/inventory/ledger": {
    title: "Stock Ledger",
    subtitle: "Inventory movement history",
  },
  "/inventory/adjustments": {
    title: "Stock Adjustments",
    subtitle: "Inventory adjustment records",
  },
  "/production/bom": {
    title: "Bill of Materials",
    subtitle: "Production material requirements",
  },
  "/production/runs": {
    title: "Production Runs",
    subtitle: "Production execution and output records",
  },
  "/production/runs/new": {
    title: "New Production Run",
    subtitle: "Record production details",
  },
  "/production/costing": {
    title: "Production Costing",
    subtitle: "Production costs and material consumption",
  },
  "/sales/orders": {
    title: "Sales Orders",
    subtitle: "Customer orders and fulfillment status",
  },
  "/sales/orders/new": {
    title: "Create Sales Order",
    subtitle: "Capture a customer sales order",
  },
  "/sales/review": {
    title: "Order Review",
    subtitle: "Review and approve submitted orders",
  },
  "/offline-orders": {
    title: "Offline Orders",
    subtitle: "Locally saved orders and synchronization status",
  },
  "/invoices": {
    title: "GST Invoices",
    subtitle: "Sales invoices and tax information",
  },
  "/dispatch": {
    title: "Dispatch",
    subtitle: "Finished goods dispatch records",
  },
  "/payments": {
    title: "Payments",
    subtitle: "Customer payments and allocations",
  },
  "/outstanding": {
    title: "Outstanding",
    subtitle: "Customer receivables and unpaid balances",
  },
  "/reports": {
    title: "Reports",
    subtitle: "Operational and financial reporting",
  },
  "/government-documents": {
    title: "Government Documents",
    subtitle: "Mock government document records",
  },
};

function joinClasses(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}

function normalizePathname(pathname: string): string {
  if (pathname === "/") {
    return pathname;
  }

  return pathname.replace(/\/+$/, "");
}

function humanizeSegment(segment: string): string {
  return segment
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => {
      return (
        part.charAt(0).toUpperCase() +
        part.slice(1)
      );
    })
    .join(" ");
}

function getPageMetadata(
  pathname: string,
  roleLabel?: string,
): PageMetadata {
  const normalizedPath = normalizePathname(pathname);

  const exactMatch = PAGE_METADATA[normalizedPath];

  if (exactMatch) {
    if (
      normalizedPath === "/dashboard" &&
      roleLabel
    ) {
      return {
        title: "Dashboard",
        subtitle: `${roleLabel} workspace`,
      };
    }

    return exactMatch;
  }

  if (
    /^\/production\/runs\/[^/]+$/.test(normalizedPath)
  ) {
    return {
      title: "Production Run",
      subtitle: "Production run details",
    };
  }

  if (
    /^\/sales\/orders\/[^/]+$/.test(normalizedPath)
  ) {
    return {
      title: "Sales Order",
      subtitle: "Sales order details",
    };
  }

  if (
    /^\/invoices\/[^/]+$/.test(normalizedPath)
  ) {
    return {
      title: "Invoice Details",
      subtitle: "GST invoice information",
    };
  }

  if (
    /^\/reports\/[^/]+$/.test(normalizedPath)
  ) {
    return {
      title: "Report Viewer",
      subtitle: "Report details",
    };
  }

  const segments = normalizedPath
    .split("/")
    .filter(Boolean);

  const finalSegment = segments[segments.length - 1];

  if (!finalSegment) {
    return {
      title: "Dashboard",
      subtitle: "Operational overview",
    };
  }

  return {
    title: humanizeSegment(finalSegment),
  };
}

/**
 * Authenticated application shell with responsive navigation.
 * Route authorization remains the responsibility of ProtectedRoute
 * and the backend.
 */
export function AppLayout({
  children,
  title,
  subtitle,
  headerActions,
  sidebarCollapsed = false,
  className,
  contentClassName,
  testId,
}: AppLayoutProps) {
  const location = useLocation();

  const {
    user,
    isAuthenticated,
  } = useAuth();

  const [mobileSidebarOpen, setMobileSidebarOpen] =
    useState(false);

  const [collapsed, setCollapsed] =
    useState(sidebarCollapsed);

  useEffect(() => {
    setCollapsed(sidebarCollapsed);
  }, [sidebarCollapsed]);

  const closeMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(false);
  }, []);

  const toggleMobileSidebar = useCallback(() => {
    setMobileSidebarOpen((current) => !current);
  }, []);

  useEffect(() => {
    closeMobileSidebar();
  }, [location.pathname, closeMobileSidebar]);

  useEffect(() => {
    if (!isAuthenticated) {
      closeMobileSidebar();
    }
  }, [isAuthenticated, closeMobileSidebar]);

  const roleLabel = user
    ? USER_ROLE_LABELS[user.role]
    : undefined;

  const pageMetadata = getPageMetadata(
    location.pathname,
    roleLabel,
  );

  const pageTitle = title ?? pageMetadata.title;
  const pageSubtitle =
    subtitle ?? pageMetadata.subtitle;

  return (
    <div
      className={joinClasses(
        "flex h-screen h-dvh min-h-0 w-full",
        "overflow-hidden bg-background",
        "font-sans text-text-primary",
        className,
      )}
      data-testid={testId}
    >
      <a
        href="#app-main-content"
        className="app-skip-link"
      >
        Skip to main content
      </a>

      <AppSidebar
        open={mobileSidebarOpen}
        onClose={closeMobileSidebar}
        collapsed={collapsed}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AppHeader
          title={pageTitle}
          subtitle={pageSubtitle}
          onMenuClick={toggleMobileSidebar}
          sidebarOpen={mobileSidebarOpen}
          showMenuButton
          actions={headerActions}
        />

        <main
          id="app-main-content"
          tabIndex={-1}
          className={joinClasses(
            "min-h-0 min-w-0 flex-1",
            "overflow-x-hidden overflow-y-auto",
            "overscroll-contain",
            "focus:outline-none",
          )}
        >
          <div
            className={joinClasses(
              "mx-auto w-full max-w-[1600px]",
              "px-4 py-5 sm:px-6 sm:py-6",
              "lg:px-8 lg:py-8",
              contentClassName,
            )}
          >
            {children ?? <Outlet />}
          </div>
        </main>

        <footer className="shrink-0 border-t border-border bg-surface px-4 py-2 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-text-muted">
            <span>
              Food Manufacturing Management System
            </span>

            {roleLabel && (
              <span>
                {roleLabel}
              </span>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

export default AppLayout;