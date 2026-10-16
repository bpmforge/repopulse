import yaml
from yaml import SafeLoader


class Loader:
    def load(self, text):
        return text


def safe(text):
    return yaml.safe_load(text)


def explicit_safe_loader(text):
    return yaml.load(text, Loader=yaml.SafeLoader)


def positional_safe_loader(text):
    return yaml.load(text, yaml.SafeLoader)


def unrelated(text):
    return Loader().load(text)
