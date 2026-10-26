# Algorithmic shapes, Python (W21-20). Each is linear in one collection per
# element of another (O(n·m)), or quadratic in one (O(k²)).


def trades_by_symbol(symbols, trades):
    out = {}
    for symbol in symbols:
        out[symbol] = [t for t in trades if t.symbol == symbol]
    return out


def first_order(order_ids, orders):
    return [next(o for o in orders if o.id == oid) for oid in order_ids]


def unseen(rows, seen_rows):
    seen = list(seen_rows)
    return [r for r in rows if r not in seen]


def drain_fifo(lots, qty):
    while qty > 0:
        lot = lots[0]
        qty -= lot
        lots.pop(0)
    return lots


def flatten(groups):
    acc = []
    for g in groups:
        acc = acc + [g.head]
    return acc
