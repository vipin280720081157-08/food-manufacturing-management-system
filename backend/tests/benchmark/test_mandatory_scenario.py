"""The mandatory benchmark runs in a private, repeatable SQLite database."""

from __future__ import annotations

import importlib.util
import sys
from decimal import Decimal
from pathlib import Path

from sqlalchemy import create_engine, event, select, func
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import hash_password
from app.models import (
    AuditLog,
    Base,
    InventoryBalance,
    Invoice,
    ProductionCostSummary,
    ProductionRun,
    Role,
    StockMovement,
    User,
    UserRole,
)


PROJECT_ROOT = Path(__file__).resolve().parents[3]
SEED_PATH = PROJECT_ROOT / "database" / "seeds" / "seed_benchmark.py"
OPENING_FG_COST = Decimal("19.850000")


def _load_seed_module():
    spec = importlib.util.spec_from_file_location("isolated_benchmark_seed", SEED_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the benchmark seed module.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _seed_users(session_factory, seed_module) -> None:
    fixture = seed_module.load_fixture()
    with session_factory.begin() as session:
        roles = {}
        for role_name in sorted({user["role"] for user in fixture["users"]}):
            role = Role(role_name=role_name, description="Isolated benchmark test role.")
            session.add(role)
            roles[role_name] = role
        session.flush()
        for index, definition in enumerate(fixture["users"]):
            user = User(
                full_name=definition["display_name"],
                email=f"benchmark-user-{index}@test.local",
                password_hash=hash_password("IsolatedTestPassword123!"),
                is_active=True,
            )
            user.role_assignment = UserRole(role=roles[definition["role"]])
            session.add(user)


def test_mandatory_benchmark_is_verified_and_idempotent() -> None:
    seed_module = _load_seed_module()
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    @event.listens_for(engine, "connect")
    def _register_btrim(connection, _record):
        connection.create_function("btrim", 1, lambda value: value.strip() if value else value)

    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    original_session_factory = seed_module.SessionLocal
    seed_module.SessionLocal = session_factory

    try:
        _seed_users(session_factory, seed_module)
        fixture = seed_module.load_fixture()

        assert seed_module.seed_benchmark(fixture, OPENING_FG_COST) is False

        with session_factory() as session:
            expected_balances = {
                item["item_key"]: Decimal(item["quantity"])
                for item in fixture["expected_results"]["stock_balances"]
            }
            for item_key, expected in expected_balances.items():
                balance = session.scalar(
                    select(InventoryBalance).where(
                        InventoryBalance.item_id == seed_module.fixture_uuid("inventory_item", item_key),
                        InventoryBalance.location == "WAREHOUSE",
                    )
                )
                assert balance is not None
                assert Decimal(balance.quantity_on_hand) == expected

            invoice = session.get(
                Invoice,
                seed_module.fixture_uuid("invoice", "retailer_a_invoice"),
            )
            assert invoice is not None
            assert invoice.taxable_amount == Decimal("7500.00")
            assert invoice.cgst_amount == Decimal("187.50")
            assert invoice.sgst_amount == Decimal("187.50")
            assert invoice.total_amount == Decimal("7875.00")

            run = session.get(
                ProductionRun,
                seed_module.fixture_uuid("production_run", "murukku_production_run"),
            )
            assert run is not None
            summary = session.scalar(
                select(ProductionCostSummary).where(
                    ProductionCostSummary.production_run_id == run.production_run_id
                )
            )
            assert summary is not None
            assert summary.material_cost + summary.packaging_cost == Decimal("4055.00")
            assert summary.total_cost == Decimal("5855.00")
            assert Decimal(summary.cost_per_unit).quantize(Decimal("0.01")) == Decimal("31.14")
            assert session.scalar(select(func.count()).select_from(StockMovement)) > 0
            assert session.scalar(select(func.count()).select_from(AuditLog)) > 0
            count_before_repeat = session.scalar(select(func.count()).select_from(AuditLog))

        assert seed_module.seed_benchmark(fixture, OPENING_FG_COST) is True

        with session_factory() as session:
            assert session.scalar(select(func.count()).select_from(StockMovement)) > 0
            assert session.scalar(select(func.count()).select_from(AuditLog)) == count_before_repeat
    finally:
        seed_module.SessionLocal = original_session_factory
        engine.dispose()
