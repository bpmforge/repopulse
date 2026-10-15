"""Settings.

Point WEBHOOK_URL at your receiver, for example "https://hooks.example.org/notify".
"""
import asyncio
import importlib
import logging
import os
from datetime import datetime, timezone

try:
    import imp
except ImportError:
    imp = None

from app.logs import log

API_KEY = os.environ.get("API_KEY")
DEFAULT_PASSWORD_FIELD = "password"

# >>> settings.load("prod")
# >>> settings.API_KEY
# 'abc'
# >>> settings.reload()

# authority = [ userinfo "@" ] host [ ":" port ]
# userinfo  = *( unreserved / pct-encoded / sub-delims / ":" )
# host      = IP-literal / IPv4address / reg-name

# Regenerate the table with:
#   python3 -c "
#   import table
#   table.build()
#   "

# For exposition, write:
#  yarr = isinstance(y, list)
#  yint = is_integer(y)
#  ybool = is_bool(y)


async def serve():
    loop = asyncio.get_event_loop()
    return loop


def stamp():
    log.warn("a project logger whose warn is its own API")
    logging.getLogger(__name__).warning("stamping")
    return datetime.now(timezone.utc), importlib


if __name__ == "__main__":
    print("demo against https://api.example.com/v1", API_KEY)
