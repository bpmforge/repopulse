"""Half of a deliberate import cycle (W10-03 fixture)."""

import requests  # deliberately NOT installed: the graph must survive it

from shop import checkout


def subtotal(items):
    return checkout.apply_tax(sum(item.price for item in items))
