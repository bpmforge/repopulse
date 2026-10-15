import logging
import unittest

import numpy.testing as npt
import pytest

from shop.cart import total


def check_total(items, want):
    assert total(items) == want


@pytest.fixture
def verified_cart():
    cart = [1, 2]
    assert total(cart) == 3
    return cart


def test_uses_assert():
    assert total([1, 2]) == 3


def test_uses_raises():
    with pytest.raises(TypeError):
        total(None)


def test_uses_helper():
    check_total([2, 2], 4)


def test_uses_numpy_testing():
    npt.assert_allclose(total([0.1, 0.2]), 0.3)


def test_relies_on_an_asserting_fixture(verified_cart):
    total(verified_cart)


def test_does_not_raise_on_empty():
    total([])


def test_documents_its_smoke_contract():
    # No exceptions should be raised.
    total([1])


@pytest.mark.skip(reason="not ready")
def test_skipped():
    total([1])


def test_skips_at_run_time():
    pytest.importorskip("decimal")
    total([1])


def test_equality_is_reflexive():
    # `==` runs the type's own __eq__: this is a real check.
    item = total([1])
    assert item == item


def test_must_fail():
    try:
        assert total([1]) == 2
        pytest.fail("a wrong total was accepted")
    except AssertionError:
        pass


def test_must_fail_else():
    try:
        assert total([1]) == 2
    except AssertionError:
        pass
    else:
        raise RuntimeError("expected a failure")


def test_catches_a_different_error():
    try:
        assert total([1]) == 1
    except ValueError:
        logging.info("not an assertion error")


def test_outer():
    def test_inner_helper():
        total([1])

    assert test_inner_helper() is None


class TotalCase(unittest.TestCase):
    def test_assert_equal(self):
        self.assertEqual(total([1]), 1)

    def test_inherited_check(self):
        self.check_rounding(total([1.5]))


class Helper:
    def test_method(self):
        total([1])


class TestOverride(TotalCase):
    def test_assert_equal(self):
        pass
