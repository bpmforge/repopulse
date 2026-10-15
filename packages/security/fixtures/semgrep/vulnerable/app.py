# Security baseline triggers, Python (W18-11). Every rule in
# bpm-baseline.python.v1.yaml must fire on this file; safe/app.py does the
# same jobs safely.
import hashlib
import os
import random
import subprocess

import jwt


def calculate(expression):
    return eval(expression)


def run_plugin(code, scope):
    exec(code, scope)


def archive(name):
    subprocess.run(f"tar czf /tmp/{name}.tgz /srv/data", shell=True, check=True)
    os.system("rm -rf /tmp/" + name)


def find_user(cursor, user_id):
    cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")
    return cursor.fetchone()


def find_orders(cursor, status):
    query = "SELECT * FROM orders WHERE status = '%s'" % status
    cursor.execute(query)
    return cursor.fetchall()


def password_digest(password):
    return hashlib.md5(password.encode()).hexdigest()


def issue_reset(user):
    reset_token = "".join(random.choice("abcdef0123456789") for _ in range(32))
    user.session_id = random.getrandbits(64)
    return reset_token


def current_user(token, key):
    claims = jwt.decode(token, key, algorithms=["HS256"], options={"verify_signature": False})
    return claims["sub"]
