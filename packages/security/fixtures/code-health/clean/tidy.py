# Anti-slop near-misses, Python (W18-11). Same jobs as triggering/slop.py,
# done in ways no rule in anti-slop.python.v1.yaml may fire on.
import abc
import contextlib
import json
import logging
import time
from typing import overload

log = logging.getLogger(__name__)


def read_config(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except OSError as err:
        log.warning("config unreadable, using defaults: %s", err)
        return {"defaults": True}


def remove_stale(path):
    # A missing file is the state we wanted; nothing to report.
    with contextlib.suppress(FileNotFoundError):
        path.unlink()


def transaction(conn, work):
    try:
        work(conn)
    except:
        conn.rollback()
        raise


def import_rows(rows):
    for row in rows:
        try:
            int(row)
        except ValueError as err:
            raise ValueError(f"bad row {row!r}") from err


def fetch_with_retry(fetch, attempts):
    while attempts > 0:
        try:
            return fetch()
        except ConnectionError:
            attempts -= 1
            time.sleep(1)
    raise ConnectionError("gave up")


def find_user(db, user_id):
    try:
        return db.get(user_id)
    except KeyError:
        log.info("no user %s", user_id)
        return None


def cached(cache, key):
    # EAFP: a narrow, named miss is a decision, not a swallowed failure.
    try:
        return cache[key]
    except KeyError:
        pass
    return None


def first(values):
    try:
        return values[0]
    except IndexError:
        return None


def parse_all(rows):
    parsed = []
    for row in rows:
        try:
            parsed.append(int(row))
        except ValueError:
            parsed.append(0)
    return parsed


def maybe_flush(buffer):
    try:
        buffer.flush()
    except BrokenPipeError:
        return


class Exporter(abc.ABC):
    def export_csv(self, report):
        raise NotImplementedError

    @abc.abstractmethod
    def export_pdf(self, report):
        raise NotImplementedError


@overload
def parse(value: int) -> int: ...
@overload
def parse(value: str) -> str: ...
def parse(value):
    return value


def total(items):
    # Items are validated upstream, so a plain sum is safe here.
    acc = 0
    for item in items:
        acc += item
    # set the cap at 100 because the UI paginates at that size
    capped = min(acc, 100)
    # The cap is applied after summing so an overflow shows up in the
    # return value.
    #        return acc
    return capped


def _unsupported(op):
    raise NotImplementedError(op)
