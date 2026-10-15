# Logging triggers, Python (W18-11). Every rule in logging.python.v1.yaml must
# fire on this file; clean/logging_tidy.py does the same jobs properly.
import logging

from flask import request

logger = logging.getLogger(__name__)


def handle_upload(store):
    print("upload started")
    name = request.args.get("name")
    logger.info(f"upload requested for {name}")
    logger.warning("bad filename %s", request.form["filename"])
    return store.save(name)


def authenticate(client, user):
    token = client.issue(user)
    logger.debug("issued %s", token)
    logger.info(f"login for {user.email} with {user.password}")
    logging.error("auth header was %s", request.headers["Authorization"])
    return token


def charge(gateway, card):
    try:
        return gateway.charge(card)
    except TimeoutError as err:
        logger.error("charge failed: %s", err)
        raise


def refund(gateway, charge_id):
    try:
        return gateway.refund(charge_id)
    except ConnectionError:
        logger.exception("refund failed")
        raise
