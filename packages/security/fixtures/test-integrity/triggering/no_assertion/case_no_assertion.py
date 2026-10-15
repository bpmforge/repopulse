import pytest

from shop.discount import apply_discount


def test_applies_discount():
    apply_discount(100, 0.1)


def test_placeholder():
    pass


class TestDiscount:
    def test_zero_price(self):
        result = apply_discount(0, 0.5)
        print(result)

    @pytest.mark.parametrize("price", [10, 20])
    def test_many_prices(self, price):
        apply_discount(price, 0.2)
