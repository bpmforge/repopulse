# Near-misses for slop.exception_control_flow (W18-09).
import logging

log = logging.getLogger(__name__)


def validate(invoice):
    """
    Docstrings are not code:
        try:
            raise ValueError("x")
        except ValueError:
            pass
    """
    if invoice.total <= 0:
        raise ValueError("no try around this one")


def charge(invoice):
    try:
        def check(x):
            # A nested function's raise is caught by whoever calls it.
            raise ValueError("nested")
        run(check)
    except ValueError:
        log.warning("check failed")


def wrong_type(invoice):
    try:
        raise KeyError("the handler does not catch KeyError")
    except ValueError:
        pass


def rethrows(invoice):
    try:
        if not invoice:
            raise ValueError("bad")
    except ValueError:
        log.exception("cleanup")
        raise


def translates(invoice):
    try:
        if not invoice:
            raise ValueError("bad")
    except ValueError as exc:
        raise RuntimeError("translated") from exc


def unknown_class(err):
    try:
        raise err
    except Exception:
        pass


def bare_reraise():
    try:
        work()
    except OSError:
        raise


def in_handler_and_else(invoice):
    try:
        work()
    except OSError:
        raise ValueError("raised from the handler leaves the try")
    else:
        raise ValueError("raised from else is not covered by the handlers")
    finally:
        log.info("done")


def exits():
    try:
        raise SystemExit(1)
    except Exception:
        pass


def run(fn):
    fn(1)


def work():
    pass
