def load(db, rows):
    # One round trip for the whole set.
    ids = [row.id for row in rows]
    return db.execute("select 1 where id = any(%s)", ids)
