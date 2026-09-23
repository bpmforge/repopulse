# W17-33 — the README followed literally from an extracted bundle, 2026-09-11

Acceptance 1 of W17-33 says following the README from an extracted bundle
produces a working install. This is that run. Raw output:
`w17-33-readme-install-20260911.txt` (the admin password was passed in the
environment and does not appear in it).

Host: macOS 26 / Apple M2 Max, podman client 6.1.0 → podman machine (rootless,
server 5.8.2), podman-compose 1.6. **No docker on this host.** Bundle:
`repopulse-0.1.0-rc1-linux-arm64.tar.gz`, sha256 `73835897…` — the **first**
W17-28 pack (the one whose smoke is recorded in
`w17-28-bundle-smoke-20260910.md`), not the re-pack `d9b29f14…`. Copied with
its `.sha256` into an empty directory under `$HOME/tmp/` outside the
repository.

## Commands, as the README gives them

```
shasum -a 256 -c repopulse-0.1.0-rc1-linux-arm64.tar.gz.sha256   → OK
tar -xzf repopulse-0.1.0-rc1-linux-arm64.tar.gz
cd repopulse-0.1.0-rc1-linux-arm64                                → VERSION: 0.1.0-rc1, linux/arm64, d3b85bc
ADMIN_PASSWORD='…' REPOPULSE_PROJECT=rp-doc ./install.sh --url=http://localhost:8299 --port=8299 --admin-email=doc@example.com
```

Two deviations from the README's literal line, both recorded rather than
hidden: `REPOPULSE_PROJECT=rp-doc` and `--port=8299`, so the run shares no
volume, container or port with the `repopulse` project already on this host
(the W17-28 smoke hit exactly that collision on its first attempt). A
customer on a fresh host does not need either.

## Result

```
RepoPulse 0.1.0-rc1 (linux/arm64), built from d3b85bc…
== verifying checksums … OK
runtime: podman
== loading images … 6 loaded as localhost/repopulse/<name>:0.1.0-rc1
== writing deploy/.env       (PUBLIC_BASE_URL=http://localhost:8299, REPOPULSE_PORT=8299)
== starting
rp-doc_postgres_1  rp-doc_redis_1  rp-doc_scan-runner_1  rp-doc_migrate_1  rp-doc_api_1  rp-doc_worker_1  rp-doc_web_1
All services running. Open http://localhost:8099
INSTALL EXIT 0                                                    05:23:03Z → 05:23:26Z
```

Through the only published port, `127.0.0.1:8299`:

| Request | Status |
|---|---|
| `GET /healthz` | 200 |
| `GET /` | 200 |
| `GET /api/v1/me/context` | 401 |
| `POST /auth/local/login` without `X-Requested-With` | 403 `Missing or invalid X-Requested-With header` (the CSRF guard; expected for a bare curl) |
| `POST /auth/local/login` with `X-Requested-With: repopulse` | 200 `{"must_change_password":true}` |

Containers after install: postgres and redis `healthy`; scan-runner, api,
worker, web `Up`. Torn down with `podman compose -p rp-doc … down -v`: 0
containers and 0 `rp-doc*` volumes remain.

## What this run says about the documents

- The README's five lines are sufficient: checksum, extract, `cd`,
  `install.sh`, `curl /healthz`. Nothing else was typed.
- **One stale line in this pack, already fixed in the repository:** the
  final `Open http://localhost:8099` ignored `--port=8299`. That is the first
  pack's `up.sh` (line 343, `${REPOPULSE_PORT:-8099}` from the shell only);
  the committed `up.sh` reads the port from `.env` and the W17-28 re-pack
  observed the corrected line. The README's install block therefore does not
  quote that line; it tells the reader to open the URL they gave `--url=`.
- The login step in the docs is done in a browser, which sends the header;
  the 403 above is a curl artefact, not a product defect.

## Not proven here

- amd64, docker, rootful podman, Windows/WSL2 — none on this host; the README
  and `INSTALL.md` say so.
- Connecting a real forge, TLS, `scan-db-sync.sh` from the bundle, upgrade
  between two bundle versions — outside this acceptance; the documents cite
  W17-29/W17-30 where they are covered and say "not evidenced" where they are
  not.
