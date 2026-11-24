"""FastAPI application entry point."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config import settings
from app.core.database import dispose_engine


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Release pooled connections when the local or hosted API stops."""
    yield
    dispose_engine()


app = FastAPI(
    title="Food Manufacturing Management System API",
    version="1.0.0",
    description="Order-to-audit workflows for small food manufacturers.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
)

app.include_router(api_router, prefix="/api/v1")


@app.get("/health", tags=["Health"])
def health() -> dict[str, str]:
    return {"status": "ok", "environment": settings.ENVIRONMENT}


@app.get("/", include_in_schema=False)
def root() -> dict[str, str]:
    return {"name": app.title, "docs": "/docs", "health": "/health"}
