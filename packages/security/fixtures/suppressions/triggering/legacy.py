import json  # noqa
import os  # NOQA
from typing import Any

from .models import Model  # type: ignore


def load(path):  # pylint: disable=all
    data = json.load(open(path))  # type: ignore
    return Model(**data)  # noqa: E501  # type: ignore
