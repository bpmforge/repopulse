def load(db, rows):
    # One round trip for the whole set.
    ids = [row.id for row in rows]
    return db.execute("select 1 where id = any(%s)", ids)


def label_rows(rows, labels):
    # Dictionary lookups and file saves in a loop are not database calls.
    out = []
    for row in rows:
        out.append(labels.get(row.kind, "other"))
        row.image.save(row.path)
    return out


def load_orders(Order, ids):
    # One query for the whole set.
    return list(Order.objects.filter(pk__in=ids))


def names(session, connection, query, table):
    # The iterable is evaluated once: one query, then a loop over its rows.
    for row in session.scalars(query):
        record(row.name)
    return {row[0] for row in connection.execute(table.select())}
