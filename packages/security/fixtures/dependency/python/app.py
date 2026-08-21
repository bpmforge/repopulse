# V2 usage-detection fixture (W8-13). requests is imported; jinja2 is not.
import requests


def fetch(url):
    return requests.get(url).text
