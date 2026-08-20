"""The other half of the cycle."""

from shop import cart


def apply_tax(amount):
    return amount * 1.2 if cart else amount
