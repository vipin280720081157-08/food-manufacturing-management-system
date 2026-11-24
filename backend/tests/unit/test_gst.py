from decimal import Decimal

import pytest

from app.utils.calculations import calculate_gst, calculate_invoice_totals


def test_in_state_benchmark_invoice_splits_gst_evenly():
    tax = calculate_gst("7500", "5", "Tamil Nadu", "Tamil Nadu")
    assert tax.cgst_amount == Decimal("187.50")
    assert tax.sgst_amount == Decimal("187.50")
    assert tax.igst_amount == Decimal("0.00")
    assert tax.total_amount == Decimal("7875.00")


def test_interstate_gst_uses_igst():
    tax = calculate_gst("1000", "5", "Tamil Nadu", "Karnataka")
    assert tax.cgst_amount == tax.sgst_amount == Decimal("0.00")
    assert tax.igst_amount == Decimal("50.00")


def test_invoice_totals_sum_rounded_lines():
    lines = [calculate_gst("50", "5", "TN", "TN") for _ in range(150)]
    totals = calculate_invoice_totals(lines)
    assert totals.taxable_amount == Decimal("7500.00")
    assert totals.total_amount == Decimal("7875.00")


def test_gst_rejects_float_inputs():
    with pytest.raises(TypeError):
        calculate_gst(100.0, "5", "TN", "TN")
