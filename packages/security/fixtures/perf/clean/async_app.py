# Perf near-misses, Python (W18-11). Same jobs as triggering/async_app.py,
# done in ways no rule in the perf pack may fire on.
import asyncio
import copy
import re
import time

import httpx

TAG = re.compile(r"#(\w+)")


async def refresh(client, url):
    await asyncio.sleep(1)
    async with httpx.AsyncClient() as http:
        page = await http.get(url)
    return await client.store(page)


async def checksum(path):
    def digest():
        time.sleep(0)
        return path.read_bytes()

    return await asyncio.to_thread(digest)


def blocking_report(url):
    # Not a coroutine: blocking here is fine.
    time.sleep(1)


async def load_users(client, ids):
    users = []
    for start in range(0, len(ids), 10):
        users.extend(await asyncio.gather(*[client.fetch_user(i) for i in ids[start : start + 10]]))
    return users


async def poll(job):
    while not job.done:
        await asyncio.sleep(0.5)


def snapshot(state):
    return copy.deepcopy(state)


def find_tags(lines, words):
    found = []
    for line in lines:
        found.extend(TAG.findall(line))
    for word in words:
        # Built from the loop variable, so it has to be compiled per word.
        found.extend(re.compile(re.escape(word)).findall(" ".join(lines)))
    return found


def render(rows):
    parts = ["<table>"]
    for row in rows:
        parts.append(f"<tr><td>{row}</td></tr>")
    parts.append("</table>")
    return "".join(parts)


def total(rows):
    amount = 0
    for row in rows:
        amount += row.amount
    return amount


async def fetch_bounded(client, ids):
    sem = asyncio.Semaphore(10)

    async def one(i):
        async with sem:
            return await client.fetch_user(i)

    return await asyncio.gather(*[one(i) for i in ids])


async def children(parent):
    # Awaited once, in the loop header, not per iteration.
    return [child.name for child in await parent.awaitable_attrs.children]


async def stream(send, chunks):
    # Ordered stream I/O is sequential by definition.
    for chunk in chunks:
        await send({"type": "http.response.body", "body": chunk, "more_body": True})
