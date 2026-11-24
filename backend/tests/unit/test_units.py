from decimal import Decimal

from app.utils.calculations import calculate_stock_balance, calculate_stock_shortage


def test_benchmark_finished_stock_after_production_and_dispatch():
    assert calculate_stock_balance("50", "188", "150") == Decimal("88.000")


def test_shortage_is_reported_without_negative_stock():
    assert calculate_stock_shortage("120", "88") == Decimal("32.000")
    assert calculate_stock_shortage("10", "12") == Decimal("0.000")
