import { lazy, Suspense } from "react";

import {
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import { USER_ROLES } from "../../types/auth";

import type { UserRole } from "../../types/auth";

import { useAuth } from "../../hooks/useAuth";

import { LoadingState } from "../../components/common/LoadingState";

import AuthLayout from "../layouts/AuthLayout";
import AppLayout from "../layouts/AppLayout";

import {
  AccessDenied,
  GuestRoute,
  ProtectedRoute,
} from "./ProtectedRoute";

const LoginPage = lazy(
  () => import("../../features/authentication/LoginPage"),
);

const CustomersPage = lazy(
  () => import("../../features/customers/CustomersPage"),
);

const SuppliersPage = lazy(
  () => import("../../features/suppliers/SuppliersPage"),
);

const ProductsPage = lazy(
  () => import("../../features/products/ProductsPage"),
);

const PriceListsPage = lazy(
  () => import("../../features/products/PriceListsPage"),
);

const UsersPage = lazy(
  () => import("../../features/users/UsersPage"),
);

const PurchasesPage = lazy(
  () => import("../../features/purchasing/PurchasesPage"),
);

const GoodsReceiptsPage = lazy(
  () => import("../../features/purchasing/GoodsReceiptsPage"),
);

const StockSummaryPage = lazy(
  () => import("../../features/inventory/StockSummaryPage"),
);

const StockBatchesPage = lazy(
  () => import("../../features/inventory/StockBatchesPage"),
);

const StockLedgerPage = lazy(
  () => import("../../features/inventory/StockLedgerPage"),
);

const StockAdjustmentsPage = lazy(
  () => import("../../features/inventory/StockAdjustmentsPage"),
);

const BOMPage = lazy(
  () => import("../../features/production/BOMPage"),
);

const ProductionRunsPage = lazy(
  () => import("../../features/production/ProductionRunsPage"),
);

const ProductionRunFormPage = lazy(
  () => import("../../features/production/ProductionRunFormPage"),
);

const ProductionCostingPage = lazy(
  () => import("../../features/production/ProductionCostingPage"),
);

const SalesOrdersPage = lazy(
  () => import("../../features/sales/SalesOrdersPage"),
);

const CreateOrderPage = lazy(
  () => import("../../features/sales/CreateOrderPage"),
);

const OrderReviewPage = lazy(
  () => import("../../features/sales/OrderReviewPage"),
);

const OfflineOrdersPage = lazy(
  () => import("../../features/offline-sync/OfflineOrdersPage"),
);

const InvoicesPage = lazy(
  () => import("../../features/invoicing/InvoicesPage"),
);

const InvoiceDetailsPage = lazy(
  () => import("../../features/invoicing/InvoiceDetailsPage"),
);

const DispatchPage = lazy(
  () => import("../../features/dispatch/DispatchPage"),
);

const PaymentsPage = lazy(
  () => import("../../features/payments/PaymentsPage"),
);

const OutstandingPage = lazy(
  () => import("../../features/payments/OutstandingPage"),
);

const ReportsPage = lazy(
  () => import("../../features/reports/ReportsPage"),
);

const ReportViewerPage = lazy(
  () => import("../../features/reports/ReportViewerPage"),
);

const GovernmentDocumentsPage = lazy(
  () =>
    import(
      "../../features/government-mock/GovernmentDocumentsPage"
    ),
);

const SalesmanDashboardPage = lazy(
  () =>
    import(
      "../../features/dashboard/SalesmanDashboardPage"
    ),
);

const AdminDashboardPage = lazy(
  () =>
    import(
      "../../features/dashboard/AdminDashboardPage"
    ),
);

const ProductionDashboardPage = lazy(
  () =>
    import(
      "../../features/dashboard/ProductionDashboardPage"
    ),
);

const AccountantDashboardPage = lazy(
  () =>
    import(
      "../../features/dashboard/AccountantDashboardPage"
    ),
);

const OwnerDashboardPage = lazy(
  () =>
    import(
      "../../features/dashboard/OwnerDashboardPage"
    ),
);

const {
  SALESMAN,
  FACTORY_ADMIN,
  PRODUCTION_SUPERVISOR,
  ACCOUNTANT_AUDITOR,
  OWNER,
} = USER_ROLES;

const ALL_ROLES: readonly UserRole[] = [
  SALESMAN,
  FACTORY_ADMIN,
  PRODUCTION_SUPERVISOR,
  ACCOUNTANT_AUDITOR,
  OWNER,
];

const MANAGEMENT_ROLES: readonly UserRole[] = [
  FACTORY_ADMIN,
  PRODUCTION_SUPERVISOR,
  ACCOUNTANT_AUDITOR,
  OWNER,
];

const SALES_ROLES: readonly UserRole[] = [
  SALESMAN,
  FACTORY_ADMIN,
  ACCOUNTANT_AUDITOR,
  OWNER,
];

const ORDER_CREATION_ROLES: readonly UserRole[] = [
  SALESMAN,
  FACTORY_ADMIN,
];

const PRODUCTION_ROLES: readonly UserRole[] = [
  FACTORY_ADMIN,
  PRODUCTION_SUPERVISOR,
  ACCOUNTANT_AUDITOR,
  OWNER,
];

const FINANCE_ROLES: readonly UserRole[] = [
  FACTORY_ADMIN,
  ACCOUNTANT_AUDITOR,
  OWNER,
];

const GOVERNMENT_DOCUMENT_ROLES: readonly UserRole[] = [
  FACTORY_ADMIN,
  ACCOUNTANT_AUDITOR,
  OWNER,
];

const REPORT_ROLES: readonly UserRole[] = ALL_ROLES;

const DASHBOARD_PATHS: Record<UserRole, string> = {
  [SALESMAN]: "/dashboard/salesman",
  [FACTORY_ADMIN]: "/dashboard/admin",
  [PRODUCTION_SUPERVISOR]: "/dashboard/production",
  [ACCOUNTANT_AUDITOR]: "/dashboard/accountant",
  [OWNER]: "/dashboard/owner",
};

function RouteLoadingFallback() {
  return (
    <div
      className="flex min-h-[50vh] items-center justify-center px-4 py-10"
      role="status"
      aria-live="polite"
    >
      <LoadingState
        variant="section"
        message="Loading page..."
      />
    </div>
  );
}

function DashboardRedirect() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <RouteLoadingFallback />;
  }

  if (!user || !user.is_active) {
    return (
      <Navigate
        to="/login"
        replace
      />
    );
  }

  return (
    <Navigate
      to={DASHBOARD_PATHS[user.role]}
      replace
    />
  );
}

function NotFoundPage() {
  const location = useLocation();
  const { user } = useAuth();

  const destination =
    user?.is_active
      ? "/dashboard"
      : "/login";

  return (
    <div className="app-page mx-auto flex min-h-[50vh] max-w-2xl flex-col items-center justify-center px-4 text-center">
      <div className="rounded-card border border-border bg-surface p-8 shadow-card sm:p-10">
        <p className="text-sm font-semibold uppercase tracking-widest text-text-muted">
          Error 404
        </p>

        <h1 className="mt-3 text-2xl font-bold text-text-primary">
          Page not found
        </h1>

        <p className="mt-3 text-sm leading-6 text-text-muted">
          The requested page does not exist or is no
          longer available.
        </p>

        <p className="mt-3 break-all text-xs text-text-muted">
          {location.pathname}
        </p>

        <NavigateLink to={destination}>
          {user?.is_active
            ? "Return to dashboard"
            : "Go to login"}
        </NavigateLink>
      </div>
    </div>
  );
}

function NavigateLink({
  to,
  children,
}: {
  to: string;
  children: string;
}) {
  return (
    <a
      href={to}
      className="app-button app-button-primary mt-6 inline-flex items-center justify-center"
    >
      {children}
    </a>
  );
}

function AuthenticatedApplicationRoutes() {
  return (
    <Route
      element={<ProtectedRoute />}
    >
      <Route
        element={<AppLayout />}
      >
        <Route
          index
          element={
            <Navigate
              to="/dashboard"
              replace
            />
          }
        />

        <Route
          path="dashboard"
          element={<DashboardRedirect />}
        />

        <Route
          element={
            <ProtectedRoute
              allowedRoles={[SALESMAN]}
            />
          }
        >
          <Route
            path="dashboard/salesman"
            element={<SalesmanDashboardPage />}
          />

          <Route
            path="offline/orders"
            element={<OfflineOrdersPage />}
          />
        </Route>

        <Route
          element={
            <ProtectedRoute
              allowedRoles={[FACTORY_ADMIN]}
            />
          }
        >
          <Route
            path="dashboard/admin"
            element={<AdminDashboardPage />}
          />

          <Route
            path="sales/orders/review"
            element={<OrderReviewPage />}
          />

          <Route
            path="users"
            element={<UsersPage />}
          />
        </Route>

        <Route
          element={
            <ProtectedRoute
              allowedRoles={[PRODUCTION_SUPERVISOR]}
            />
          }
        >
          <Route
            path="dashboard/production"
            element={<ProductionDashboardPage />}
          />
        </Route>

        <Route
          element={
            <ProtectedRoute
              allowedRoles={[ACCOUNTANT_AUDITOR]}
            />
          }
        >
          <Route
            path="dashboard/accountant"
            element={<AccountantDashboardPage />}
          />
        </Route>

        <Route
          element={
            <ProtectedRoute
              allowedRoles={[OWNER]}
            />
          }
        >
          <Route
            path="dashboard/owner"
            element={<OwnerDashboardPage />}
          />
        </Route>

        <Route
          element={
            <ProtectedRoute
              allowedRoles={MANAGEMENT_ROLES}
            />
          }
        >
          <Route
            path="customers"
            element={<CustomersPage />}
          />

          <Route
            path="suppliers"
            element={<SuppliersPage />}
          />

          <Route
            path="products"
            element={<ProductsPage />}
          />

          <Route
            path="products/price-lists"
            element={<PriceListsPage />}
          />

          <Route
            path="purchasing/purchases"
            element={<PurchasesPage />}
          />

          <Route
            path="purchasing/goods-receipts"
            element={<GoodsReceiptsPage />}
          />

          <Route
            path="inventory/stock-summary"
            element={<StockSummaryPage />}
          />

          <Route
            path="inventory/batches"
            element={<StockBatchesPage />}
          />

          <Route
            path="inventory/stock-ledger"
            element={<StockLedgerPage />}
          />

          <Route
            path="inventory/adjustments"
            element={<StockAdjustmentsPage />}
          />
        </Route>

        <Route
          element={
            <ProtectedRoute
              allowedRoles={PRODUCTION_ROLES}
            />
          }
        >
          <Route
            path="production/boms"
            element={<BOMPage />}
          />

          <Route
            path="production/runs"
            element={<ProductionRunsPage />}
          />

          <Route
            path="production/runs/:runId"
            element={<ProductionRunFormPage />}
          />

          <Route
            path="production/costing"
            element={<ProductionCostingPage />}
          />
        </Route>

        <Route
          element={
            <ProtectedRoute
              allowedRoles={SALES_ROLES}
            />
          }
        >
          <Route
            path="sales/orders"
            element={<SalesOrdersPage />}
          />
        </Route>

        <Route
          element={
            <ProtectedRoute
              allowedRoles={ORDER_CREATION_ROLES}
            />
          }
        >
          <Route
            path="sales/orders/new"
            element={<CreateOrderPage />}
          />
        </Route>

        <Route
          element={
            <ProtectedRoute
              allowedRoles={FINANCE_ROLES}
            />
          }
        >
          <Route
            path="invoices"
            element={<InvoicesPage />}
          />

          <Route
            path="invoices/:invoiceId"
            element={<InvoiceDetailsPage />}
          />

          <Route
            path="payments"
            element={<PaymentsPage />}
          />

          <Route
            path="payments/outstanding"
            element={<OutstandingPage />}
          />
        </Route>

        <Route
          element={
            <ProtectedRoute
              allowedRoles={MANAGEMENT_ROLES}
            />
          }
        >
          <Route
            path="dispatch"
            element={<DispatchPage />}
          />
        </Route>

        <Route
          element={
            <ProtectedRoute
              allowedRoles={REPORT_ROLES}
            />
          }
        >
          <Route
            path="reports"
            element={<ReportsPage />}
          />

          <Route
            path="reports/:reportId"
            element={<ReportViewerPage />}
          />
        </Route>

        <Route
          element={
            <ProtectedRoute
              allowedRoles={GOVERNMENT_DOCUMENT_ROLES}
            />
          }
        >
          <Route
            path="government-documents"
            element={<GovernmentDocumentsPage />}
          />
        </Route>

        <Route
          path="access-denied"
          element={<AccessDenied />}
        />

        <Route
          path="*"
          element={<NotFoundPage />}
        />
      </Route>
    </Route>
  );
}

export function AppRoutes() {
  return (
    <Suspense fallback={<RouteLoadingFallback />}>
      <Routes>
        <Route
          element={<GuestRoute />}
        >
          <Route
            element={<AuthLayout />}
          >
            <Route
              path="/login"
              element={<LoginPage />}
            />
          </Route>
        </Route>

        {AuthenticatedApplicationRoutes()}

        <Route
          path="*"
          element={<NotFoundPage />}
        />
      </Routes>
    </Suspense>
  );
}

export default AppRoutes;