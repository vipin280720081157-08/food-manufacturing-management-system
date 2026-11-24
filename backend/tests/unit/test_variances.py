from decimal import Decimal

from app.utils.calculations import calculate_yield_variance


def test_benchmark_production_yield_variance():
    result = calculate_yield_variance("200", "188")
    assert result.variance_quantity == Decimal("-12.000")
    assert result.variance_percentage == Decimal("-6.00")
    assert result.exceeds_tolerance is True
