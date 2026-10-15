def load(db, rows):
    out = []
    for row in rows:
        out.append(db.execute("select 1", row.id))
    return out


def load_orders(Order, ids):
    return [Order.objects.get(pk=i) for i in ids] + [o for o in ids]


def touch_all(session, User, ids):
    for user_id in ids:
        user = session.get(User, user_id)
        user.seen = True
        user.save(update_fields=["seen"])
