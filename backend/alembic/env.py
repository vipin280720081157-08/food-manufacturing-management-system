"""
Alembic migration environment for the Food Manufacturing Management System.

Uses the configured Supabase PostgreSQL connection and the complete
SQLAlchemy model registry for schema migration autogeneration.

Importing this module through Alembic does not automatically create
application tables, seed data, or execute migrations.
"""

from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool
from sqlalchemy.engine import Connection, make_url

# Make backend/app importable when Alembic runs from the backend directory.
BACKEND_DIR = Path(__file__).resolve().parents[1]

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.config import settings
from app.models import Base

# Alembic configuration supplied by backend/alembic.ini.
config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# All application models are imported by app.models.init.
target_metadata = Base.metadata


def get_database_url() -> str:
    """
    Return the configured PostgreSQL connection URL.

    Database credentials come from Pydantic Settings and the
    environment, never from migration source code.
    """

    database_url = str(settings.DATABASE_URL)

    parsed_url = make_url(database_url)

    if parsed_url.get_backend_name() != "postgresql":
        raise ValueError(
            "Alembic migrations require a PostgreSQL database."
        )

    if parsed_url.drivername != "postgresql+psycopg":
        raise ValueError(
            "Alembic migrations require the Psycopg 3 driver "
            "(postgresql+psycopg)."
        )

    return database_url


def include_object(
    object,
    name: str | None,
    type_: str,
    reflected: bool,
    compare_to,
) -> bool:
    """
    Restrict autogeneration to application-owned schema objects.

    Existing database objects that are absent from the SQLAlchemy
    model registry must not be automatically marked for deletion.
    This protects unrelated Supabase-managed objects and prevents
    accidental destructive changes during autogeneration.
    """

    if type_ == "table":
        if reflected and compare_to is None:
            return False

    if type_ in {
        "column",
        "index",
        "unique_constraint",
        "foreign_key_constraint",
    }:
        if reflected and compare_to is None:
            return False

    return True


def run_migrations_offline() -> None:
    """
    Configure SQL-only migration generation.

    Offline mode produces migration SQL without establishing
    a database connection.
    """

    database_url = get_database_url()

    context.configure(
        url=database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={
            "paramstyle": "named",
        },
        compare_type=True,
        compare_server_default=True,
        include_schemas=False,
        include_object=include_object,
        version_table="alembic_version",
        transactional_ddl=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """
    Configure migrations using a PostgreSQL database connection.

    Alembic controls migration transactions. Application database
    sessions and business transactions are not used here.
    """

    existing_connection = config.attributes.get("connection")

    if existing_connection is not None:
        if not isinstance(existing_connection, Connection):
            raise TypeError(
                "Alembic connection must be a SQLAlchemy Connection."
            )

        context.configure(
            connection=existing_connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
            include_schemas=False,
            include_object=include_object,
            version_table="alembic_version",
            transactional_ddl=True,
        )

        with context.begin_transaction():
            context.run_migrations()

        return

    database_url = get_database_url()

    # SQLAlchemy's configuration parser uses percent interpolation.
    # Escape percent signs in URL-encoded credentials before passing
    # the URL through Alembic's configuration interface.
    config.set_main_option(
        "sqlalchemy.url",
        database_url.replace("%", "%%"),
    )

    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        connect_args={
            "connect_timeout": 10,
            "options": "-c timezone=UTC",
        },
        future=True,
    )

    try:
        with connectable.connect() as connection:
            context.configure(
                connection=connection,
                target_metadata=target_metadata,
                compare_type=True,
                compare_server_default=True,
                include_schemas=False,
                include_object=include_object,
                version_table="alembic_version",
                transactional_ddl=True,
            )

            with context.begin_transaction():
                context.run_migrations()
    finally:
        connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()