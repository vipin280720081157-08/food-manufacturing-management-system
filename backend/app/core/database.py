"""
SQLAlchemy database engine and session management.

Provides database connections and request-scoped sessions.
Business services are responsible for transaction boundaries,
commits, rollbacks, and concurrency control.
"""

from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.models.base import Base


def create_database_engine() -> Engine:
    """Create the PostgreSQL engine using application settings."""

    if settings.DATABASE_URL.startswith("sqlite:///"):
        path = settings.DATABASE_URL.removeprefix("sqlite:///")
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        sqlite_engine = create_engine(
            settings.DATABASE_URL,
            connect_args={"check_same_thread": False},
            echo=False,
        )
        @event.listens_for(sqlite_engine, "connect")
        def _sqlite_functions(connection, _record) -> None:
            connection.create_function(
                "btrim",
                1,
                lambda value: value.strip() if value else value,
            )
            connection.execute("PRAGMA foreign_keys=ON")

        return sqlite_engine

    return create_engine(
        settings.DATABASE_URL,
        pool_pre_ping=True,
        pool_recycle=1800,
        pool_size=5,
        max_overflow=10,
        pool_timeout=30,
        connect_args={
            "connect_timeout": 10,
            "options": "-c timezone=UTC",
        },
        echo=False,
        future=True,
    )


engine: Engine = create_database_engine()


SessionLocal = sessionmaker(
    bind=engine,
    class_=Session,
    autoflush=False,
    expire_on_commit=False,
    autocommit=False,
)


def get_db() -> Generator[Session, None, None]:
    """
    Provide a database session for a FastAPI request.

    The session is rolled back if an exception occurs.
    Uncommitted changes are also rolled back when the
    session closes.

    Successful business transactions must be explicitly
    committed by the responsible service layer.
    """

    db = SessionLocal()

    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def get_db_session() -> Session:
    """
    Create a database session for non-request operations.

    The caller must close the returned session and explicitly
    manage transaction commits and rollbacks.
    """

    return SessionLocal()


def dispose_engine() -> None:
    """Release pooled database connections."""

    engine.dispose()
