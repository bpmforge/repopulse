# Near-misses from the W21-20 hand-check: each shape below was marked wrong
# on real code, and no performance rule may fire on it.


def expire(order_ids):
    # One query: the comprehension is the argument, not the loop body.
    OrderEvent.objects.bulk_create([OrderEvent(order_id=i) for i in order_ids])
    return Order.objects.filter(id__in=[i for i in order_ids])


def rename(batches):
    # One query per batch is the batched form.
    for batch in batches:
        ProductVariant.objects.bulk_update(batch, ["name"])


def scheduled(triggers):
    # A queryset that is built but not evaluated runs no query.
    out = []
    for trigger in triggers:
        documents = Document.objects.none()
        if trigger.kind == "added":
            documents = Document.objects.filter(added__lte=trigger.at)
        out.append(documents)
    return out


def labels(rows):
    # A string assigned afresh each iteration accumulates nothing.
    out = []
    for row in rows:
        name = row.first
        name += " " + row.last
        out.append(name)
    return out
