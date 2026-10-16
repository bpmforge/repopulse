# Triggering fixture for the injection pack (bpm-baseline.injection.v1.yaml).
# `# ruleid: <id>` names the rule that must fire on the NEXT line.
import os
import pickle
import subprocess

import requests
import yaml
from flask import Flask, redirect, render_template_string, request, send_file

app = Flask(__name__)


@app.get("/user")
def user(cursor):
    uid = request.args.get("id")
    # ruleid: bpm-inj-sql-py
    cursor.execute("SELECT * FROM users WHERE id = '%s'" % uid)
    # ruleid: bpm-inj-sql-py
    cursor.execute(f"SELECT * FROM users WHERE name = '{request.args['name']}'")
    return "ok"


@app.post("/ping")
def ping():
    host = request.form["host"]
    # ruleid: bpm-inj-cmd-py
    os.system("ping -c 1 " + host)
    # ruleid: bpm-inj-cmd-py
    subprocess.run("nslookup " + host, shell=True)
    return "ok"


@app.get("/download")
def download():
    name = request.args.get("file")
    # ruleid: bpm-inj-path-py
    return send_file("/srv/uploads/" + name)


@app.get("/read")
def read():
    # ruleid: bpm-inj-path-py
    with open("./data/" + request.args["f"]) as handle:
        return handle.read()


@app.get("/hello")
def hello():
    # ruleid: bpm-inj-xss-py
    return render_template_string("<h1>Hello " + request.args.get("name", "") + "</h1>")


@app.get("/proxy")
def proxy():
    url = request.args.get("url")
    # ruleid: bpm-inj-ssrf-py
    return requests.get(url).text


@app.get("/go")
def go():
    # ruleid: bpm-inj-redirect-py
    return redirect(request.args.get("next"))


@app.post("/load")
def load():
    # ruleid: bpm-inj-deserialize-py
    obj = pickle.loads(request.data)
    # ruleid: bpm-inj-deserialize-py
    cfg = yaml.load(request.data)
    return str((obj, cfg))
