# Security baseline near-misses, Python (W18-11). Same jobs as
# vulnerable/app.py, done in ways no rule in the pack may fire on.
import ast
import hashlib
import random
import secrets
import subprocess

import jwt


def calculate(expression):
    return ast.literal_eval(expression)


def version_check():
    return eval("1 + 1")


def archive(name):
    subprocess.run(["tar", "czf", f"/tmp/{name}.tgz", "/srv/data"], check=True)
    subprocess.run("du -sh /srv/data", shell=True, check=True)


def find_user(cursor, user_id):
    cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))
    return cursor.fetchone()


def run_task(runner, name):
    # Not SQL: a task runner's execute.
    return runner.execute(f"build:{name}")


def etag(body):
    return hashlib.md5(body, usedforsecurity=False).hexdigest()


def password_digest(password, salt):
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)


def issue_reset(user):
    reset_token = secrets.token_urlsafe(32)
    cache_key = random.randint(0, 10)
    jitter = random.uniform(0, 1)
    return reset_token, cache_key, jitter


def current_user(token, key):
    claims = jwt.decode(token, key, algorithms=["HS256"])
    return claims["sub"]


def fetch(client, url):
    return client.decode(url, verify=False)
