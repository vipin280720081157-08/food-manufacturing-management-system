
"""
Shared SQLAlchemy model foundation.

Provides the declarative base, UUID primary keys, timestamp mixins,
and PostgreSQL NUMERIC conventions used by application models.

Business-specific relationships, constraints, and transaction rules
belong in their respective model and service modules.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Final

from sqlalchemy import DateTime, MetaData, Numeric, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


# Consistent constraint names for PostgreSQL and Alembic.
NAMING_CONVENTION: Final[dict[str, str]] = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": (
        "fk_%(table_name)s_%(column_0_name)s_"
        "%(referred_table_name)s"
    ),
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """
    Shared declarative base for all application ORM models.

    All model classes must inherit from this base, directly
    or through the reusable mixins below.
    """

    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class UUIDPrimaryKeyMixin:
    """
    Reusable PostgreSQL UUID primary key.

    UUID values are generated in Python before INSERT.
    """

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )


class TimestampMixin:
    """
    Reusable timezone-aware creation and modification timestamps.

    PostgreSQL supplies the timestamps using its database clock.
    updated_at is refreshed by SQLAlchemy-generated UPDATEs.

    These timestamps do not replace immutable transaction
    histories or dedicated audit log records.
    """

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


# Financial totals, including invoice and payment amounts.
MONEY_TYPE: Final[Numeric] = Numeric(
    precision=18,
    scale=2,
    asdecimal=True,
)

# Unit prices, weighted-average costs, and inventory valuations.
UNIT_COST_TYPE: Final[Numeric] = Numeric(
    precision=18,
    scale=6,
    asdecimal=True,
)

# Standard stock and production quantities.
# Individual models may require greater precision.
QUANTITY_TYPE: Final[Numeric] = Numeric(
    precision=18,
    scale=3,
    asdecimal=True,
)

# GST percentages and other applicable tax rates.
TAX_RATE_TYPE: Final[Numeric] = Numeric(
    precision=7,
    scale=4,
    asdecimal=True,
)


# Python-side monetary type used by business calculations.
Money = Decimal
