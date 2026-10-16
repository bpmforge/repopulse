import yaml
import yaml as y
from yaml import load
from yaml import load as ld


def plain(text):
    # ruleid: bpm-reach-pypi-pyyaml-load
    return yaml.load(text)


def aliased(text):
    # ruleid: bpm-reach-pypi-pyyaml-load
    return y.load(text)


def from_import(text):
    # ruleid: bpm-reach-pypi-pyyaml-load
    return load(text)


def renamed(text):
    # ruleid: bpm-reach-pypi-pyyaml-load
    return ld(text)


def every(text):
    # ruleid: bpm-reach-pypi-pyyaml-load-all
    return list(yaml.load_all(text))


def full(text):
    # ruleid: bpm-reach-pypi-pyyaml-full-load
    return yaml.full_load(text)
