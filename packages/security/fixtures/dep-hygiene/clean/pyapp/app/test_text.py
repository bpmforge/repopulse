import re


def slugify(value):
    return re.sub(r"\W+", "-", value).lower()
