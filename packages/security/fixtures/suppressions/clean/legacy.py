import json  # noqa: F401
import os  # noqa:E402

from .models import Model  # type: ignore[attr-defined]

PROSE = "add # noqa or # type: ignore to silence it"
DOC = """
    # type: ignore inside a docstring is text
"""


def load(path):  # pylint: disable=invalid-name
    # the noqa docs say to name a code; # type: ignore[...] names one too
    data = json.load(open(path))  # type: ignore[arg-type]
    hash_sign = "#"  # a quoted hash does not start a comment
    return Model(**data), hash_sign, os.sep, PROSE, DOC
