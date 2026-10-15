# Anti-slop triggers, Python (W18-11). Every rule in anti-slop.python.v1.yaml
# must fire on this file; tidy.py does the same jobs without the slop.
import json


def read_config(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        pass


def read_quietly(path):
    try:
        return open(path).read()
    except (ValueError, Exception) as err:
        pass


def load_everything(path):
    try:
        return open(path).read()
    except:
        return "default"


def import_rows(rows):
    imported = 0
    for row in rows:
        try:
            imported += int(row)
        except Exception:
            continue
    return imported


def find_user(db, user_id):
    try:
        return db.get(user_id)
    except Exception:
        return None


def list_orders(db, user_id):
    try:
        return db.orders(user_id)
    except BaseException as err:
        return []


def export_to_pdf(report):
    raise NotImplementedError


def export_to_xlsx(report):
    """Exports the report as a spreadsheet."""
    raise NotImplementedError("export")


class Exporter:
    def export_csv(self, report):
        raise NotImplementedError("Not implemented yet")


def sync_calendar(user):
    raise RuntimeError("Coming soon: calendar sync")


def send_invoice(invoice):
    # TODO: wire up the mailer
    pass


def total(items):
    # initialize the total
    acc = 0
    # Step 1: add the items
    for item in items:
        acc += item
    # 🚀 fast path
    # It is important to note that the items are already validated.
    return acc
