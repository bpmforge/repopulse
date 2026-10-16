#!/usr/bin/env python3
"""Builds the OpenSSF malicious-packages index RepoPulse matches against (W18-37).

Runs inside the scan image during deploy/scan-db-sync.sh (the only step of the
sync that has network). OSV republishes the OpenSSF malicious-packages feed as
`MAL-*` advisories inside each ecosystem's `all.zip` dump, so one download per
ecosystem is enough and nothing is cloned.

Usage: build-malicious-index.py OUT_DIR [ECOSYSTEM=PATH_OR_URL ...]
With no ecosystem arguments it fetches the default set from osv.dev's bucket.
Writes OUT_DIR/index.json:
  {"generated": ISO8601, "source": "...", "entries": {"npm": {"name": [{"id","summary","versions"}]}}}
`versions` is a list of affected versions, or null when every version is affected.
"""
import io
import json
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone

BUCKET = "https://osv-vulnerabilities.storage.googleapis.com/{eco}/all.zip"
DEFAULT_ECOSYSTEMS = ["npm", "PyPI", "crates.io", "RubyGems", "NuGet", "Go", "Maven"]


def affects_all(affected):
    """True when an OSV range says 'introduced 0' with no fix or last-affected bound."""
    for rng in affected.get("ranges", []):
        events = rng.get("events", [])
        introduced_zero = any(e.get("introduced") == "0" for e in events)
        bounded = any("fixed" in e or "last_affected" in e for e in events)
        if introduced_zero and not bounded:
            return True
    return False


def read_zip(blob):
    entries = {}
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        for name in archive.namelist():
            base = name.rsplit("/", 1)[-1]
            if not base.startswith("MAL-") or not base.endswith(".json"):
                continue
            doc = json.loads(archive.read(name))
            for affected in doc.get("affected", []):
                pkg = affected.get("package", {})
                eco, pname = pkg.get("ecosystem"), pkg.get("name")
                if not eco or not pname:
                    continue
                versions = None if affects_all(affected) else sorted(affected.get("versions", []))
                if versions == [] and not affects_all(affected):
                    versions = None  # no version data at all: treat the package as affected
                entries.setdefault(eco, {}).setdefault(pname.lower(), []).append(
                    {"id": doc["id"], "summary": (doc.get("summary") or "")[:200], "versions": versions}
                )
    return entries


def fetch(source):
    if source.startswith(("http://", "https://")):
        with urllib.request.urlopen(source, timeout=300) as response:  # noqa: S310 - fixed https bucket
            return response.read()
    with open(source, "rb") as handle:
        return handle.read()


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    out_dir = argv[1]
    sources = dict(a.split("=", 1) for a in argv[2:]) or {
        eco: BUCKET.format(eco=eco) for eco in DEFAULT_ECOSYSTEMS
    }
    merged = {}
    for eco, source in sources.items():
        for key, packages in read_zip(fetch(source)).items():
            for pname, items in packages.items():
                merged.setdefault(key, {}).setdefault(pname, []).extend(items)
    index = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "source": "OpenSSF malicious-packages via osv.dev",
        "entries": merged,
    }
    with open(f"{out_dir}/index.json", "w", encoding="utf-8") as handle:
        json.dump(index, handle, separators=(",", ":"))
    total = sum(len(v) for eco in merged.values() for v in eco.values())
    print(f"malicious-packages: {total} advisories across {len(merged)} ecosystems")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
