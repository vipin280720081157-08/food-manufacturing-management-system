"""Versioned API router assembly."""

from fastapi import APIRouter

from app.api.routes.auth import router as auth_router, users_router
from app.api.routes.synchronization import router as synchronization_router
from app.api.routes.sales import router as sales_router, legacy_router as legacy_sales_router
from app.api.routes.invoicing import router as invoicing_router
from app.api.routes.production import router as production_router
from app.api.routes.customers import router as customers_router
from app.api.routes.suppliers import router as suppliers_router
from app.api.routes.dashboard import router as dashboard_router

api_router = APIRouter()
api_router.include_router(auth_router)
api_router.include_router(users_router)
api_router.include_router(synchronization_router)
api_router.include_router(sales_router)
api_router.include_router(legacy_sales_router)
api_router.include_router(invoicing_router)
api_router.include_router(production_router)
api_router.include_router(customers_router)
api_router.include_router(suppliers_router)
api_router.include_router(dashboard_router)
