# Fixture for slop.exception_control_flow (W18-09). `expect:` names the rule
# that must report the NEXT line.
import logging

log = logging.getLogger(__name__)


class InvoiceError(Exception):
    pass


def charge(invoice):
    try:
        if invoice.total <= 0:
            # expect: slop.exception_control_flow
            raise ValueError("nothing to charge")
        gateway_charge(invoice)
        return {"ok": True}
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}


async def refund(invoice):
    try:
        async with lock(invoice):
            if not invoice.paid:
                # expect: slop.exception_control_flow
                raise InvoiceError("not paid")
            await gateway_refund(invoice)
    except Exception:
        log.exception("refund failed")
        return False
    return True


def lookup(rates, currency):
    try:
        if currency not in rates:
            # expect: slop.exception_control_flow
            raise KeyError(currency)
        return rates[currency]
    except LookupError:
        return 1.0


def gateway_charge(invoice):
    pass


async def gateway_refund(invoice):
    pass


def lock(invoice):
    pass
