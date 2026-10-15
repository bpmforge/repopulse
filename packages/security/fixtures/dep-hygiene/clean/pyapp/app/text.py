from slugify import slugify as _slug
import tenacity


def slugify(value):
    """Wrapper: we used to re.sub(...) here; now the library does it."""
    return _slug(value, max_length=80)


def retry(fn):
    return tenacity.retry(stop=tenacity.stop_after_attempt(3))(fn)
