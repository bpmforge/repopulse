import ssl
import subprocess

import requests
from django.views.decorators.csrf import csrf_exempt
from flask import Flask
from flask_cors import CORS

app = Flask(__name__)
CORS(app, supports_credentials=True)
app.config["WTF_CSRF_ENABLED"] = False


def fetch(url):
    return requests.get(url, timeout=5, verify=False)


def legacy_context():
    return ssl._create_unverified_context()


def thumbnail(path):
    return subprocess.run(f"convert {path} out.png", shell=True, check=True)


def archive(name):
    return subprocess.check_output("tar czf " + name + ".tgz data", shell=True)


@csrf_exempt
def webhook(request):
    return request.body


def session_client():
    s = requests.Session()
    s.verify = False
    return s
