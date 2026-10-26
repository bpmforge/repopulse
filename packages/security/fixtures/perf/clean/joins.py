# The same jobs done in linear time, and the look-alikes that are not
# quadratic. None of these may fire (W21-20).
from collections import defaultdict, deque

CLOSED = ["merged", "closed"]


def trades_by_symbol(symbols, trades):
    grouped = defaultdict(list)
    for t in trades:
        grouped[t.symbol].append(t)
    return {s: grouped[s] for s in symbols}


def unseen(rows, seen_rows):
    seen = set(seen_rows)
    return [r for r in rows if r not in seen]


# A fixed constant list is bounded.
def closed(prs):
    return [p for p in prs if p.state in CLOSED]


# `in` on a dict is O(1): nothing proves a list here.
def known(names, registry):
    return [n for n in names if n in registry]


def drain_fifo(lots, qty):
    queue = deque(lots)
    while qty > 0:
        qty -= queue.popleft()
    return list(queue)


def flatten(groups):
    acc = []
    for g in groups:
        acc.append(g.head)
    return acc
