from decimal import Decimal

from app.utils.calculations import calculate_weighted_average_cost


def test_weighted_average_cost_for_flour_receipt():
    result = calculate_weighted_average_cost("100", "42", "60", "45")
    assert result == Decimal("43.125000")
