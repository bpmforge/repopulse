# Clean near-misses: the same sources and sinks, handled safely.
import html
import os
import pickle
import subprocess

import requests
import yaml
from flask import Flask, redirect, request, send_file, url_for
from werkzeug.utils import secure_filename

app = Flask(__name__)


@app.get("/user")
def user(cursor):
    cursor.execute("SELECT * FROM users WHERE id = %s", (request.args.get("id"),))
    uid = int(request.args["id"])
    cursor.execute(f"SELECT * FROM users WHERE id = {uid}")
    return "ok"


@app.post("/ping")
def ping():
    subprocess.run(["ping", "-c", "1", request.form["host"]])
    os.system("uptime")
    return "ok"


@app.get("/download")
def download():
    name = secure_filename(request.args.get("file", ""))
    return send_file(os.path.join("/srv/uploads", name))


@app.get("/hello")
def hello():
    return "<h1>Hello " + html.escape(request.args.get("name", "")) + "</h1>"


@app.get("/proxy")
def proxy():
    item = int(request.args["item"])
    return requests.get(f"https://api.internal.example/items/{item}").text


@app.get("/go")
def go():
    return redirect(url_for("index"))


@app.post("/load")
def load():
    cfg = yaml.safe_load(request.data)
    with open("/var/lib/app/state.pkl", "rb") as handle:
        return str((pickle.load(handle), cfg))
