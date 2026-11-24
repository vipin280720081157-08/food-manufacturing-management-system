"""
Audit trail service for important business and administrative actions.

Audit entries are stored in the existing app.models.audit.AuditLog
table. The service does not commit or roll back transactions: callers
must persist each audit entry in the same transaction as the business
operation being recorded.

Audit history is append-only. Sensitive credentials and authentication
material are excluded from audit snapshots.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from datetime import date, datetime, time
from decimal import Decimal
from enum import Enum
from typing import Any
from uuid import UUID

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.models.audit import AuditLog


SENSITIVE_FIELD_NAMES = frozenset(
    {
        "password",
        "password_hash",
        "current_password",
        "new_password",
        "confirm_password",
        "password_confirmation",
        "secret",
        "secret_key",
        "client_secret",
        "api_key",
        "access_token",
        "refresh_token",
        "id_token",
        "authorization",
        "cookie",
        "set_cookie",
        "database_url",
        "database_password",
        "connection_string",
        "private_key",
        "credential",
        "credentials",
    }
)

MAX_ENTITY_TYPE_LENGTH = 100
MAX_ACTION_LENGTH = 100
MAX_SNAPSHOT_DEPTH = 20
MAX_SNAPSHOT_BYTES = 256_000


class AuditValidationError(ValueError):
    """Invalid audit input or unsupported audit snapshot data."""


def _validate_identifier(value: UUID, field_name: str) -> UUID:
    if not isinstance(value, UUID):
        raise AuditValidationError(
            f"{field_name} must be a UUID."
        )
    return value


def _validate_label(
    value: str,
    field_name: str,
    maximum_length: int,
) -> str:
    if not isinstance(value, str):
        raise AuditValidationError(
            f"{field_name} must be a string."
        )

    normalized = value.strip()

    if not normalized:
        raise AuditValidationError(
            f"{field_name} cannot be blank."
        )

    if len(normalized) > maximum_length:
        raise AuditValidationError(
            f"{field_name} cannot exceed {maximum_length} characters."
        )

    return normalized


def _normalize_field_name(value: str) -> str:
    return value.strip().lower().replace("-", "_").replace(" ", "_")


def _is_sensitive_field(value: str) -> bool:
    normalized = _normalize_field_name(value)

    if normalized in SENSITIVE_FIELD_NAMES:
        return True

    sensitive_suffixes = (
        "_password",
        "_password_hash",
        "_secret",
        "_secret_key",
        "_token",
        "_api_key",
        "_private_key",
        "_credential",
        "_credentials",
    )

    return normalized.endswith(sensitive_suffixes)


def _serialize_value(value: Any, depth: int = 0) -> Any:
    """
    Convert supported values into JSON-compatible audit data.

    Unsupported objects are rejected rather than serialized using
    repr(), which could expose credentials or internal application
    state. Sensitive mapping keys are omitted recursively.
    """

    if depth > MAX_SNAPSHOT_DEPTH:
        raise AuditValidationError(
            "Audit snapshot exceeds the permitted nesting depth."
        )

    if value is None or isinstance(value, (str, bool, int)):
        return value

    if isinstance(value, float):
        if not math.isfinite(value):
            raise AuditValidationError(
                "Audit snapshots cannot contain non-finite numbers."
            )
        return value

    if isinstance(value, Decimal):
        if not value.is_finite():
            raise AuditValidationError(
                "Audit snapshots cannot contain non-finite decimals."
            )
        return str(value)

    if isinstance(value, UUID):
        return str(value)

    if isinstance(value, (datetime, date, time)):
        return value.isoformat()

    if isinstance(value, Enum):
        return _serialize_value(value.value, depth + 1)

    if isinstance(value, Mapping):
        serialized: dict[str, Any] = {}

        for key, item in value.items():
            if not isinstance(key, str):
                raise AuditValidationError(
                    "Audit snapshot field names must be strings."
                )

            if _is_sensitive_field(key):
                continue

            serialized[key] = _serialize_value(
                item,
                depth + 1,
            )

        return serialized

    if isinstance(value, (list, tuple)):
        return [
            _serialize_value(item, depth + 1)
            for item in value
        ]

    raise AuditValidationError(
        "Audit snapshots must contain JSON-compatible values, "
        "dates, UUIDs, decimals, or supported collections."
    )


def prepare_audit_snapshot(
    values: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    """
    Prepare an independent JSON-safe snapshot.

    Sensitive fields are removed recursively. The size limit
    prevents unexpectedly large audit records.
    """

    if values is None:
        return None

    if not isinstance(values, Mapping):
        raise AuditValidationError(
            "Audit snapshot must be a mapping or None."
        )

    snapshot = _serialize_value(values)

    if not isinstance(snapshot, dict):
        raise AuditValidationError(
            "Audit snapshot must serialize to a JSON object."
        )

    encoded = json.dumps(
        snapshot,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")

    if len(encoded) > MAX_SNAPSHOT_BYTES:
        raise AuditValidationError(
            "Audit snapshot exceeds the permitted size."
        )

    return snapshot


def create_audit_log(
    db: Session,
    *,
    user_id: UUID,
    entity_type: str,
    entity_id: UUID,
    action: str,
    old_values: Mapping[str, Any] | None = None,
    new_values: Mapping[str, Any] | None = None,
) -> AuditLog:
    """
    Add an audit entry to the caller's current transaction.

    This function deliberately does not commit, roll back, or
    create an independent transaction. A failed business operation
    must not leave behind an audit entry claiming it succeeded.

    The returned entry is pending in the supplied SQLAlchemy
    session until the caller flushes or commits the transaction.
    """

    if not isinstance(db, Session):
        raise TypeError(
            "db must be a SQLAlchemy Session."
        )

    validated_user_id = _validate_identifier(
        user_id,
        "user_id",
    )
    validated_entity_id = _validate_identifier(
        entity_id,
        "entity_id",
    )

    validated_entity_type = _validate_label(
        entity_type,
        "entity_type",
        MAX_ENTITY_TYPE_LENGTH,
    )
    validated_action = _validate_label(
        action,
        "action",
        MAX_ACTION_LENGTH,
    )

    prepared_old_values = prepare_audit_snapshot(
        old_values
    )
    prepared_new_values = prepare_audit_snapshot(
        new_values
    )

    audit_log = AuditLog(
        user_id=validated_user_id,
        entity_type=validated_entity_type,
        entity_id=validated_entity_id,
        action=validated_action,
        old_values=prepared_old_values,
        new_values=prepared_new_values,
    )

    db.add(audit_log)

    return audit_log


def create_audit_logs(
    db: Session,
    *,
    user_id: UUID,
    entries: Sequence[Mapping[str, Any]],
) -> list[AuditLog]:
    """
    Add multiple audit entries to the current transaction.

    Every entry must contain entity_type, entity_id, and action.
    Optional old_values and new_values must be mappings or None.

    All entries are validated before being added to the session.
    """

    if not isinstance(db, Session):
        raise TypeError(
            "db must be a SQLAlchemy Session."
        )

    validated_user_id = _validate_identifier(
        user_id,
        "user_id",
    )

    if not isinstance(entries, (list, tuple)):
        raise AuditValidationError(
            "entries must be a list or tuple."
        )

    prepared_entries: list[AuditLog] = []

    permitted_fields = {
        "entity_type",
        "entity_id",
        "action",
        "old_values",
        "new_values",
    }

    required_fields = {
        "entity_type",
        "entity_id",
        "action",
    }

    for entry in entries:
        if not isinstance(entry, Mapping):
            raise AuditValidationError(
                "Each audit entry must be a mapping."
            )

        missing_fields = required_fields - entry.keys()
        unexpected_fields = entry.keys() - permitted_fields

        if missing_fields:
            raise AuditValidationError(
                "Audit entry is missing required fields: "
                + ", ".join(sorted(missing_fields))
            )

        if unexpected_fields:
            raise AuditValidationError(
                "Audit entry contains unsupported fields: "
                + ", ".join(sorted(unexpected_fields))
            )

        entity_id = _validate_identifier(
            entry["entity_id"],
            "entity_id",
        )

        entity_type = _validate_label(
            entry["entity_type"],
            "entity_type",
            MAX_ENTITY_TYPE_LENGTH,
        )

        action = _validate_label(
            entry["action"],
            "action",
            MAX_ACTION_LENGTH,
        )

        old_values = prepare_audit_snapshot(
            entry.get("old_values")
        )
        new_values = prepare_audit_snapshot(
            entry.get("new_values")
        )

        prepared_entries.append(
            AuditLog(
                user_id=validated_user_id,
                entity_type=entity_type,
                entity_id=entity_id,
                action=action,
                old_values=old_values,
                new_values=new_values,
            )
        )

    db.add_all(prepared_entries)

    return prepared_entries


def get_audit_log(
    db: Session,
    audit_id: UUID,
) -> AuditLog | None:
    """
    Retrieve an audit entry by primary key.

    Callers must enforce the applicable report-viewing permission
    before exposing the returned audit record.
    """

    validated_audit_id = _validate_identifier(
        audit_id,
        "audit_id",
    )

    return db.get(
        AuditLog,
        validated_audit_id,
    )


def list_audit_logs(
    db: Session,
    *,
    user_id: UUID | None = None,
    entity_type: str | None = None,
    entity_id: UUID | None = None,
    action: str | None = None,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[AuditLog], int]:
    """
    Return filtered audit history and its total matching count.

    Results are ordered by newest timestamp, with audit_id as
    a stable secondary ordering key.

    Authentication, authorization, and user-specific visibility
    restrictions belong to the calling API or report service.
    """

    if not isinstance(db, Session):
        raise TypeError(
            "db must be a SQLAlchemy Session."
        )

    if not isinstance(page, int) or isinstance(page, bool) or page < 1:
        raise AuditValidationError(
            "page must be a positive integer."
        )

    if (
        not isinstance(page_size, int)
        or isinstance(page_size, bool)
        or not 1 <= page_size <= 500
    ):
        raise AuditValidationError(
            "page_size must be between 1 and 500."
        )

    if (
        start_time is not None
        and end_time is not None
        and end_time < start_time
    ):
        raise AuditValidationError(
            "end_time cannot precede start_time."
        )

    filters = []

    if user_id is not None:
        filters.append(
            AuditLog.user_id == _validate_identifier(
                user_id,
                "user_id",
            )
        )

    if entity_type is not None:
        filters.append(
            AuditLog.entity_type == _validate_label(
                entity_type,
                "entity_type",
                MAX_ENTITY_TYPE_LENGTH,
            )
        )

    if entity_id is not None:
        filters.append(
            AuditLog.entity_id == _validate_identifier(
                entity_id,
                "entity_id",
            )
        )

    if action is not None:
        filters.append(
            AuditLog.action == _validate_label(
                action,
                "action",
                MAX_ACTION_LENGTH,
            )
        )

    if start_time is not None:
        if (
            not isinstance(start_time, datetime)
            or start_time.tzinfo is None
            or start_time.utcoffset() is None
        ):
            raise AuditValidationError(
                "start_time must be a timezone-aware datetime."
            )

        filters.append(
            AuditLog.timestamp >= start_time
        )

    if end_time is not None:
        if (
            not isinstance(end_time, datetime)
            or end_time.tzinfo is None
            or end_time.utcoffset() is None
        ):
            raise AuditValidationError(
                "end_time must be a timezone-aware datetime."
            )

        filters.append(
            AuditLog.timestamp <= end_time
        )

    statement: Select[tuple[AuditLog]] = (
        select(AuditLog)
        .where(*filters)
        .order_by(
            AuditLog.timestamp.desc(),
            AuditLog.audit_id.desc(),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    )

    count_statement = (
        select(func.count())
        .select_from(AuditLog)
        .where(*filters)
    )

    total = db.scalar(count_statement) or 0
    records = list(
        db.scalars(statement).all()
    )

    return records, total


def get_entity_audit_history(
    db: Session,
    *,
    entity_type: str,
    entity_id: UUID,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[AuditLog], int]:
    """
    Retrieve the audit history of a particular business entity.

    The caller must first verify permission to view the entity
    and its associated audit history.
    """

    return list_audit_logs(
        db,
        entity_type=entity_type,
        entity_id=entity_id,
        page=page,
        page_size=page_size,
    )