# Perf triggers, Python (W18-11). Every rule in perf.python.v1.yaml must fire
# on this file; clean/async_app.py does the same jobs without the shapes.
import asyncio
import json
import re
import time

import requests


async def refresh(client, url):
    time.sleep(1)
    page = requests.get(url, timeout=5)
    return await client.store(page)


async def load_users(client, ids):
    users = []
    for user_id in ids:
        users.append(await client.fetch_user(user_id))
    return users


def snapshot(state):
    return json.loads(json.dumps(state))


def find_tags(lines):
    found = []
    for line in lines:
        tag = re.compile(r"#(\w+)")
        found.extend(tag.findall(line))
    return found


def render(rows):
    html = "<table>"
    for row in rows:
        html += f"<tr><td>{row}</td></tr>"
    html += "</table>"
    return html


def render_plain(rows):
    out = ""
    for row in rows:
        out += row.name
    return out


async def fetch_all(client, ids):
    return await asyncio.gather(*[client.fetch_user(i) for i in ids])
