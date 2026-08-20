"""Python import graph for the architecture register (W10-03, FR-REG-5).

Prints ONE JSON document to stdout:

    {"tool": "grimp", "version": "...", "roots": [...],
     "modules": {"pkg.a": ["pkg.b"], ...},
     "skipped": [{"package": "pkg", "reason": "..."}]}

Runs inside the --network=none sandbox with nothing installed but grimp, and
STATIC-PARSES the tree: a package whose third-party imports are absent still
produces a graph, because an unresolved import is an external module rather
than an error.

Failures are REPORTED, never swallowed: a package grimp cannot graph appears in
`skipped` with its reason, so "no findings" can be told apart from "we could
not look".
"""

import json
import os
import sys


def top_level_packages(root):
    """Directories that are importable packages, sorted for determinism."""
    packages = []
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return packages
    for entry in entries:
        path = os.path.join(root, entry)
        if os.path.isdir(path) and os.path.isfile(os.path.join(path, "__init__.py")):
            packages.append(entry)
    return packages


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    sys.path.insert(0, root)

    import grimp

    modules = {}
    skipped = []
    roots = top_level_packages(root)

    for package in roots:
        try:
            # cache_dir=None DISABLES grimp's on-disk cache. Its default is
            # `.grimp_cache` in the working directory, which is the read-only
            # snapshot mount — the tool fails with "Read-only file system"
            # otherwise. Fixed here rather than by giving the sandbox a
            # writable mount it does not otherwise need.
            graph = grimp.build_graph(package, cache_dir=None)
        except Exception as error:  # noqa: BLE001 - reported, not swallowed
            skipped.append({"package": package, "reason": str(error)[:200]})
            continue
        for module in sorted(graph.modules):
            imported = sorted(graph.find_modules_directly_imported_by(module))
            # Only edges INSIDE the snapshot: an import of `requests` says
            # nothing about this repository's own structure.
            modules[module] = [m for m in imported if m.split(".")[0] in roots]

    json.dump(
        {
            "tool": "grimp",
            "version": getattr(grimp, "__version__", "unknown"),
            "roots": roots,
            "modules": modules,
            "skipped": skipped,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
