#!/usr/bin/env python3
"""Builds the offline package-name index the slopsquat scanner reads (W21-05).

Runs inside the scan image during deploy/scan-db-sync.sh, in the short-lived
sync container that has network and never sees customer source. The scan
container itself stays --network=none: it only ever reads what this wrote.

Usage: build-package-index.py OUT_DIR [--previous DIR] [ECOSYSTEM=SOURCE ...]

It builds the ecosystems named in $SCAN_PACKAGE_INDEX_ECOSYSTEMS (default
"npm pypi rubygems") from their public sources, plus any ECOSYSTEM=SOURCE given
here, which also overrides that ecosystem's public source. SOURCE is a local
file or an https URL holding one name per line (optionally
`name<TAB>created<TAB>downloads`): how an air-gapped install, or a Maven list,
is fed in.

Public sources (no cloning; one download each):
  npm       registry.npmjs.org: the all-the-package-names package (a daily
            snapshot of every npm name), tarball checked against the
            registry's own sha512 integrity before it is read
  pypi      https://pypi.org/simple/ as PEP 691 JSON (every project name)
  rubygems  https://rubygems.org/names (every gem name, compact index)
  cargo     https://static.crates.io/db-dump.tar.gz, crates.csv only: name,
            created_at and downloads (the only source here with metadata);
            several hundred MB, so opt-in
  go        https://index.golang.org/index, INCREMENTAL from the previous
            index's cursor (first-seen time recorded as `created`); the first
            backfill takes many runs, capped by $SCAN_PACKAGE_INDEX_GO_MAX_PAGES
            (default 200 pages x 2000 entries per run); opt-in
  maven     no compact public name list exists: only a SOURCE you supply

Writes OUT_DIR/<eco>.tsv (sorted by UTF-8 bytes, names normalised exactly as
packages/security/src/scanners/slopsquat/names.ts does) and OUT_DIR/manifest.json.
An ecosystem that fails keeps its previous list when --previous has one, and
the exit code is 1 so the sync reports it.
"""
import csv
import hashlib
import base64
import io
import json
import os
import re
import shutil
import sys
import tarfile
import urllib.request
from datetime import datetime, timezone

USER_AGENT = "repopulse-scan-db-sync (package-name index)"
GO_PAGE = 2000


def normalize(eco, name):
    name = name.strip()
    if eco in ("npm", "rubygems"):
        return name.lower()
    if eco == "pypi":
        return re.sub(r"[-_.]+", "-", name.lower())
    if eco == "cargo":
        return name.lower().replace("_", "-")
    return name  # go, maven: as written


def open_url(url, accept=None, timeout=600):
    headers = {"User-Agent": USER_AGENT}
    if accept:
        headers["Accept"] = accept
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout)  # noqa: S310


def read_source(source):
    if source.startswith(("http://", "https://")):
        with open_url(source) as response:
            return response.read().decode("utf-8")
    with open(source, encoding="utf-8") as handle:
        return handle.read()


def from_lines(text):
    for line in text.splitlines():
        line = line.rstrip("\r")
        if not line or line.startswith("#") or line == "---":
            continue
        parts = line.split("\t")
        yield parts[0], (parts[1] if len(parts) > 1 else ""), (parts[2] if len(parts) > 2 else "")


def npm_names():
    with open_url("https://registry.npmjs.org/all-the-package-names/latest") as response:
        meta = json.load(response)
    dist = meta["dist"]
    with open_url(dist["tarball"]) as response:
        blob = response.read()
    integrity = dist.get("integrity", "")
    if integrity.startswith("sha512-"):
        digest = base64.b64encode(hashlib.sha512(blob).digest()).decode()
        if digest != integrity[len("sha512-"):]:
            raise RuntimeError("all-the-package-names tarball failed its sha512 integrity check")
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as archive:
        member = archive.getmember("package/names.json")
        names = json.load(archive.extractfile(member))
    source = f"npm registry, all-the-package-names@{meta.get('version', '?')}"
    return ((n, "", "") for n in names if isinstance(n, str)), source


def pypi_names():
    with open_url("https://pypi.org/simple/", accept="application/vnd.pypi.simple.v1+json") as response:
        doc = json.load(response)
    return ((p["name"], "", "") for p in doc.get("projects", [])), "pypi.org/simple (PEP 691)"


def rubygems_names():
    with open_url("https://rubygems.org/names") as response:
        text = response.read().decode("utf-8")
    return from_lines(text), "rubygems.org/names"


def cargo_names():
    csv.field_size_limit(sys.maxsize)
    rows = []
    with open_url("https://static.crates.io/db-dump.tar.gz", timeout=3600) as response:
        with tarfile.open(fileobj=response, mode="r|gz") as archive:
            for member in archive:
                if member.name.endswith("/data/crates.csv"):
                    handle = io.TextIOWrapper(archive.extractfile(member), encoding="utf-8")
                    for row in csv.DictReader(handle):
                        rows.append((row["name"], row.get("created_at", "")[:25], row.get("downloads", "")))
                    break
    if not rows:
        raise RuntimeError("crates.csv not found in the crates.io database dump")
    return iter(rows), "static.crates.io db-dump (crates.csv)"


def go_names(previous_dir, previous_manifest):
    known = {}
    if previous_dir and os.path.exists(os.path.join(previous_dir, "go.tsv")):
        with open(os.path.join(previous_dir, "go.tsv"), encoding="utf-8") as handle:
            for name, created, _ in from_lines(handle.read()):
                known[name] = created
    since = ((previous_manifest or {}).get("ecosystems", {}).get("go", {}) or {}).get("cursor") or "2019-04-10T00:00:00Z"
    max_pages = int(os.environ.get("SCAN_PACKAGE_INDEX_GO_MAX_PAGES") or "200")
    complete = False
    for _ in range(max_pages):
        with open_url(f"https://index.golang.org/index?since={since}&limit={GO_PAGE}", timeout=120) as response:
            entries = [json.loads(line) for line in response.read().decode("utf-8").splitlines() if line.strip()]
        for entry in entries:
            known.setdefault(entry["Path"], entry["Timestamp"])
        if entries:
            since = entries[-1]["Timestamp"]
        if len(entries) < GO_PAGE:
            complete = True
            break
    rows = ((name, created, "") for name, created in known.items())
    return rows, "index.golang.org (first-seen)", {"cursor": since, "complete": complete}


def write_index(out_dir, eco, rows):
    best = {}
    for name, created, downloads in rows:
        key = normalize(eco, name)
        if not key or "\t" in key or "\n" in key:
            continue
        if key not in best:
            best[key] = (created or "", downloads or "")
    keys = sorted(best, key=lambda k: k.encode("utf-8"))
    metadata = any(best[k][0] or best[k][1] for k in keys[:100000])
    with open(os.path.join(out_dir, f"{eco}.tsv"), "w", encoding="utf-8") as handle:
        for key in keys:
            created, downloads = best[key]
            handle.write(f"{key}\t{created}\t{downloads}\n" if (created or downloads) else f"{key}\n")
    return len(keys), metadata


def main(argv):
    args = argv[1:]
    if not args:
        print(__doc__, file=sys.stderr)
        return 2
    out_dir = args.pop(0)
    previous = None
    if args[:1] == ["--previous"]:
        args.pop(0)
        previous = args.pop(0)
    previous_manifest = None
    if previous and os.path.exists(os.path.join(previous, "manifest.json")):
        with open(os.path.join(previous, "manifest.json"), encoding="utf-8") as handle:
            previous_manifest = json.load(handle)
    explicit = dict(a.split("=", 1) for a in args)
    # The configured list, plus any ecosystem given a SOURCE on the command line.
    wanted = os.environ.get("SCAN_PACKAGE_INDEX_ECOSYSTEMS", "npm pypi rubygems").split()
    wanted += [eco for eco in explicit if eco not in wanted]
    builders = {"npm": npm_names, "pypi": pypi_names, "rubygems": rubygems_names, "cargo": cargo_names}
    now = datetime.now(timezone.utc).isoformat()
    manifest = {"version": 1, "generated": now, "ecosystems": {}}
    failed = []
    for eco in wanted:
        extra = {}
        try:
            if eco in explicit:
                rows, source = from_lines(read_source(explicit[eco])), explicit[eco].rsplit("/", 1)[-1]
            elif eco == "go":
                rows, source, extra = go_names(previous, previous_manifest)
            elif eco in builders:
                rows, source = builders[eco]()
            else:
                raise RuntimeError(f"no public name list for {eco}; pass {eco}=FILE")
            count, metadata = write_index(out_dir, eco, rows)
            if count == 0:
                raise RuntimeError("source returned no names")
            manifest["ecosystems"][eco] = {
                "file": f"{eco}.tsv", "count": count, "source": source,
                "generated": now, "metadata": metadata, **extra,
            }
            print(f"package-index: {eco}: {count} names ({source})")
        except Exception as error:  # noqa: BLE001 - reported, previous list kept
            failed.append(eco)
            print(f"package-index: {eco} FAILED: {error}", file=sys.stderr)
            old = ((previous_manifest or {}).get("ecosystems") or {}).get(eco)
            if old and previous and os.path.exists(os.path.join(previous, old["file"])):
                shutil.copyfile(os.path.join(previous, old["file"]), os.path.join(out_dir, old["file"]))
                manifest["ecosystems"][eco] = old
                print(f"package-index: {eco}: kept the previous list ({old.get('generated')})", file=sys.stderr)
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=1)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
