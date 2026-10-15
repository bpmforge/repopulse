# Fixture (W18-07): leftover content in Python.
import asyncio
import collections
import datetime
import imp
import logging
from distutils.core import setup
import pkg_resources

API_KEY = "YOUR_API_KEY"
WEBHOOK_URL = "https://hooks.example.org/notify"
DB_PASSWORD = "password123"
SECRET_KEY = "CHANGE_ME"

# result = compute(payload)
# if result.ok:
#     store(result)

loop = asyncio.get_event_loop()


def stamp():
    logging.warn("stamping")
    return datetime.datetime.utcnow()


def is_mapping(value):
    return isinstance(value, collections.Mapping)
