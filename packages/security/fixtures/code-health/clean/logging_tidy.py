# Logging near-misses, Python (W18-11). Same jobs as triggering/logging.py,
# done in ways no rule in logging.python.v1.yaml may fire on.
import argparse
import json
import logging

from flask import request

logger = logging.getLogger(__name__)


def handle_upload(store):
    name = request.args.get("name")
    logger.info("upload requested for %s", json.dumps(request.args.get("name")))
    logger.info("page size %d", int(request.args["size"]))
    return store.save(name)


def authenticate(client, user, usage):
    token = client.issue(user)
    logger.debug("token refreshed for user %s", user.id)
    logger.info("used %d tokens of %d", usage.token_count, usage.max_tokens)
    logger.info("password reset requested")
    return token


def charge(gateway, card):
    try:
        return gateway.charge(card)
    except TimeoutError as err:
        # Wrapped, not re-raised: the caller gets a domain error with context.
        logger.error("charge failed: %s", err)
        raise PaymentError("gateway timeout") from err


def parse_args(argv):
    parser = argparse.ArgumentParser()
    args = parser.parse_args(argv)
    if not args.token:
        parser.error("token missing")
    return args


class PaymentError(Exception):
    pass


if __name__ == "__main__":
    print("run via the worker, not directly")
