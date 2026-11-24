"""
Audit logs and offline sales-order synchronization records.

Audit logs preserve important business and administrative changes.
Synchronization records support idempotent offline order submission
and authoritative server-side synchronization outcomes.

Audit history must not be silently modified or deleted.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    JSON,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

if TYPE_CHECKING:
    from app.models.sales import SalesOrder
    from app.models.user import User


class AuditLog(Base):
    """
    Historical record of an important application action.

    The service layer records changes within the same database
    transaction as the corresponding business operation.

    Sensitive values, including passwords, authentication tokens,
    and database credentials, must never be stored in audit data.
    """

    __tablename__ = "audit_logs"

    __table_args__ = (
        CheckConstraint(
            "length(btrim(entity_type)) > 0",
            name="entity_type_not_blank",
        ),
        CheckConstraint(
            "length(btrim(action)) > 0",
            name="action_not_blank",
        ),
        Index(
            "ix_audit_logs_user_id",
            "user_id",
        ),
        Index(
            "ix_audit_logs_entity",
            "entity_type",
            "entity_id",
        ),
        Index(
            "ix_audit_logs_timestamp",
            "timestamp",
        ),
        Index(
            "ix_audit_logs_action",
            "action",
        ),
    )

    audit_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "users.user_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    entity_type: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
    )

    entity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        nullable=False,
    )

    action: Mapped[str] = mapped_column(
        String(100),
        nullable=False,
    )

    old_values: Mapped[dict[str, Any] | None] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=True,
    )

    new_values: Mapped[dict[str, Any] | None] = mapped_column(
        JSONB().with_variant(JSON(), "sqlite"),
        nullable=True,
    )

    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    user: Mapped[User] = relationship(
        "User",
        foreign_keys=[user_id],
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"AuditLog(audit_id={self.audit_id!r}, "
            f"user_id={self.user_id!r}, "
            f"entity_type={self.entity_type!r}, "
            f"entity_id={self.entity_id!r}, "
            f"action={self.action!r})"
        )


class SyncRecord(Base):
    """
    Authoritative synchronization outcome for an offline sales order.

    A client-generated local order ID and stable idempotency key
    identify a submission across network retries.

    The service layer must:
    - Authenticate the submitting user.
    - Validate the customer, products, and order contents.
    - Reject reuse of an idempotency key with different contents.
    - Return the existing result for an identical successful retry.
    - Create the sales order and successful synchronization record
      within the same database transaction.
    - Preserve failed and conflicting submissions for review.
    """

    __tablename__ = "sync_records"

    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "local_order_id",
            name="uq_sync_records_user_local_order",
        ),
        UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_sync_records_user_idempotency_key",
        ),
        CheckConstraint(
            "length(btrim(idempotency_key)) > 0",
            name="idempotency_key_not_blank",
        ),
        CheckConstraint(
            "sync_status IN ("
            "'PENDING', "
            "'SYNCED', "
            "'FAILED', "
            "'CONFLICT'"
            ")",
            name="valid_sync_status",
        ),
        CheckConstraint(
            "sync_status <> 'SYNCED' "
            "OR (order_id IS NOT NULL AND synced_at IS NOT NULL)",
            name="synced_requires_order_and_timestamp",
        ),
        CheckConstraint(
            "sync_status = 'SYNCED' "
            "OR synced_at IS NULL",
            name="synced_at_matches_status",
        ),
        Index(
            "ix_sync_records_order_id",
            "order_id",
        ),
        Index(
            "ix_sync_records_sync_status",
            "sync_status",
        ),
        Index(
            "ix_sync_records_user_status",
            "user_id",
            "sync_status",
        ),
    )

    sync_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        nullable=False,
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "users.user_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )

    order_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "sales_orders.sales_order_id",
            ondelete="RESTRICT",
        ),
        nullable=True,
    )

    local_order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        nullable=False,
    )

    idempotency_key: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )

    sync_status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
    )

    synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    error_message: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    user: Mapped[User] = relationship(
        "User",
        foreign_keys=[user_id],
        lazy="selectin",
    )

    sales_order: Mapped[SalesOrder | None] = relationship(
        "SalesOrder",
        foreign_keys=[order_id],
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return (
            f"SyncRecord(sync_id={self.sync_id!r}, "
            f"user_id={self.user_id!r}, "
            f"local_order_id={self.local_order_id!r}, "
            f"sync_status={self.sync_status!r})"
        )
