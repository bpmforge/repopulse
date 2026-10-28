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
`versions` is a list of affected versions, or null when no explicit list was
published. With null, `ranges` (when present) bounds the affected versions:
[{"introduced": "1.0.0", "fixed": "1.2.11"}, ...], SEMVER ranges only. Null with
no `ranges` means every version is affected.

RANGES ARE KEPT (2026-10-28). They used to be dropped, and an advisory that
gave only a bounded range (MAL-2023-462: fsevents >=1.0.0 <1.2.11) became
"every version" — legitimate fsevents 2.3.3 was then reported as a known
malicious package. A matcher that predates this field ignores it and keeps the
old, over-matching behaviour; it never under-matches.
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


def semver_ranges(affected):
    """Bounded SEMVER ranges as [{"introduced", "fixed"|"last_affected"}], or None.

    None when any range is unbounded or not SEMVER: then the caller cannot
    narrow the advisory and treats every version as affected.
    """
    out = []
    for rng in affected.get("ranges", []):
        if rng.get("type") != "SEMVER":
            return None
        current = None
        for event in rng.get("events", []):
            if "introduced" in event:
                current = {"introduced": event["introduced"]}
            elif current is not None and ("fixed" in event or "last_affected" in event):
                key = "fixed" if "fixed" in event else "last_affected"
                current[key] = event[key]
                out.append(current)
                current = None
        if current is not None:
            return None  # an introduced with no end: unbounded
    return out or None


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
                ranges = None
                if versions == [] and not affects_all(affected):
                    versions = None  # no explicit list: bounded by ranges, or every version
                    ranges = semver_ranges(affected)
                entry = {"id": doc["id"], "summary": (doc.get("summary") or "")[:200], "versions": versions}
                if ranges:
                    entry["ranges"] = ranges
                entries.setdefault(eco, {}).setdefault(pname.lower(), []).append(entry)
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
