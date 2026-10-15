import ssl
import subprocess

import requests
from flask import Flask
from flask_cors import CORS

app = Flask(__name__)
CORS(app, origins=["https://app.example.com"], supports_credentials=True)
CORS(app, resources={r"/api/*": {"origins": "https://app.example.com"}}, supports_credentials=True)
CORS(app)
app.config["WTF_CSRF_ENABLED"] = True

CA_BUNDLE = "/etc/ssl/certs/internal.pem"


def fetch(url):
    return requests.get(url, timeout=5, verify=CA_BUNDLE)


def strict_context():
    return ssl.create_default_context(cafile=CA_BUNDLE)


def disk_usage():
    return subprocess.run("du -sh /var/data | sort -h", shell=True, check=True)


def thumbnail(path):
    return subprocess.run(["convert", path, "out.png"], check=True)


def explain():
    # verify=False is what this module never does; neither is shell=True with input.
    return "requests.get(url, verify=False)"
