"""Shared pytest configuration for deterministic unit tests."""

from decimal import Decimal

import pytest


@pytest.fixture
def D():
    """Convenient exact-decimal constructor for finance tests."""
    return Decimal
