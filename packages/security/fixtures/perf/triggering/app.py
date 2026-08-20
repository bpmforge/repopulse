def load(db, rows):
    out = []
    for row in rows:
        out.append(db.execute("select 1", row.id))
    return out
