# W17-27 — packaged scan proof (podman), 2026-09-10

Tip under test: `2461d5d` (branch `codex/repopulse-product-completion`), clean tree.
Host: macOS, podman 6.1.0 client → podman machine (applehv, Fedora CoreOS,
rootless, server 5.8.2). No docker on this host.

Stack: `./deploy/demo.sh up` (deploy/compose.demo.yaml — the same `api`,
`worker`, `migrate`, `web`, `scan-runner` build targets as deploy/compose.yaml,
with the forge replaced by the fixture). Images rebuilt from the tip at
19:13 EDT; confirmed by `grep BACKSTOP_MARGIN_S` inside
`localhost/repopulse/scan-runner:demo` (the constant only exists at `2461d5d`).
Scan image: `localhost/repopulse/scan:dev` built 2026-08-20 from
Containerfile.scan (unchanged since).

Constraints honoured: worker has no runtime binary and no socket, runs as
`app`, `cap_drop ALL`, `no-new-privileges`. Only `scan-runner` mounts the
podman socket (`/run/container.sock`, `label=disable`, `read_only`). No
privileged mode anywhere. Scan containers run under the §2.2 profile
unchanged (`--network=none`, ro snapshot, tmpfs `/tmp`, `--user` = snapshot
owner, `--label=repopulse.scan=1`).

## Runner boot line (tip image)

```
[scan-runner] listening on http://0.0.0.0:3310 (token required); runtime podman 5.8.2 via podman-remote;
image localhost/repopulse/scan:dev present; scratch volume repopulse-demo-scan-scratch ->
/var/home/core/.local/share/containers/storage/volumes/repopulse-demo-scan-scratch/_data;
vuln-db built 2026-08-20T00:15:42Z (21d, STALE); swept 0 orphan(s)
```

## Acceptance 1 — persisted findings through the real packaged worker

Trigger (admin session, CSRF header):

```
POST /api/v1/repos/1/scan  {}                              -> 202 started 11 scanners
POST /api/v1/repos/2/scan  {"scanner_key":"code_health_tools"} -> 202
```

Runner log for the repo-1 batch (five containers, all via the runner):

```
run repopulse-scan-mtw59ko5-13-1 "opengrep"  wall=900000ms  done succeeded exit=0 in 1185ms
run repopulse-scan-mtw59ko6-13-2 "sh"        wall=900000ms  done succeeded exit=0 in 524ms
run repopulse-scan-mtw59kob-13-3 "depcruise" wall=600000ms  done succeeded exit=0 in 307ms
run repopulse-scan-mtw59kod-13-4 "opengrep"  wall=600000ms  done succeeded exit=0 in 1414ms
run repopulse-scan-mtw59lru-13-5 "opengrep"  wall=600000ms  done succeeded exit=0 in 1136ms
```

`scan_runs` rows written by the packaged worker (tip image), repo 1:

| id | scanner_key | scanner_version | status | finding_count | tool_versions |
|---|---|---|---|---|---|
| 114 | code_health_tools | lizard@1.24.0 jscpd@4.3.0 ruff@0.16.3 biome@2.5.9 | succeeded | 2 | {"ruff":"0.16.3","biome":"2.5.9","jscpd":"4.3.0","lizard":"1.24.0"} |
| 115 | semgrep | opengrep@unknown rulepack@bpm-baseline.v1.yaml | succeeded | 0 | {"opengrep":"unknown","rulepack":"bpm-baseline.v1.yaml"} |
| 117 | architecture_register | dependency_cruiser@17.4.3 | succeeded | 0 | {"dependency_cruiser":"17.4.3"} |
| 120 | logging_hygiene | logging.v1 | succeeded | 1 | |
| 116/121 | dependency_cve | syft/grype | failed | 0 | "the vulnerability database is 21 days old and grype refuses one over 5 — run deploy/scan-db-sync.sh" |

Findings persisted (repo 1 — upserts: `occurrence_count` incremented and
`last_seen_at` inside the run window 23:14:20–23:14:22Z):

| finding id | scanner_key | rule_id | file:line | occurrence_count | last_seen_at |
|---|---|---|---|---|---|
| 7 | code_health_tools | duplication.clone | src/pricing.ts:1 | 3 | 23:14:20.788Z |
| 8 | code_health_tools | tool.biome.useAwait | src/settle.ts:9 | 3 | 23:14:20.788Z |
| 10 | logging_hygiene | bpm-log-console-in-prod | src/settle.ts:10 | 2 | 23:14:21.686Z |

Fresh INSERTs (repo 2: its three code_health findings were deleted first, then
the scanner re-run; run 124 succeeded, finding_count 2):

| finding id | scanner_key | rule_id | file:line | first_seen_at |
|---|---|---|---|---|
| 19 | code_health_tools | duplication.clone | src/pricing.ts:1 | 2026-09-10 23:15:20.177Z |
| 20 | code_health_tools | tool.biome.useAwait | src/settle.ts:9 | 2026-09-10 23:15:20.177Z |

Why 2 and not 3: Biome still reports `lint/suspicious/noConsole` (verified by
running `biome lint --reporter=json` in the scan container through the
runner); the code-health run drops it on purpose because the pack rule
`bpm-log-console-in-prod` is already open for the repo
(`adapters/registry.ts:57`, `keep: 'pack'`). The earlier 3-finding rows were
created before logging_hygiene had run. Not a regression.

`GET /api/v1/repos/1/security` shows the same rows and versions (Security tab
reads only Postgres — Law 4).

## Acceptance 2 — cleanup (observed on the real runtime)

Probes were sent from inside the worker container to `http://scan-runner:3310/v1/run`
with the bearer token, against a throw-away `snap-w1727probe` directory in
the scratch volume (owner `app`).

| case | request | response | containers left (`podman ps -a --filter label=repopulse.scan=1`) |
|---|---|---|---|
| success (batch above) | 5 real scans | succeeded | 0; scratch volume empty |
| timeout | `sleep 30`, wallClockMs 3000 | `timed_out`, "scan exceeded 3000ms", durationMs 7925 (runner timer + `rm --force` wait) | 0 |
| error | `sh -c 'exit 3'`, wall 10000 | `failed`, exitCode 3 | 0 |
| runner restart mid-scan | `sleep 300`, wall 400000; `podman restart repopulse-demo_scan-runner_1` at 23:17:21Z while container `repopulse-scan-mtw5dct7-13-1` was Up | new boot: `orphan sweep removed 1 scan container(s)` … `swept 1 orphan(s)` | 0 after the sweep |

Isolation seen from inside a scan container (same probe path):

```
wget -T 3 http://1.1.1.1   -> "Network unreachable" rc=1     (--network=none)
cat /scan/a.txt            -> hello                          (snapshot readable as owner uid)
touch /scan/x              -> "Read-only file system"        (ro bind)
```

Scratch volume: `podman volume inspect repopulse-demo-scan-scratch` →
`type:tmpfs o:size=1g,mode=1777,noexec,nosuid,nodev`. Empty after every run;
no snapshot survives on disk.

Not exercised: a WORKER restart mid-scan (the runner restart covers the
container; the worker's `finally` snapshot delete and its boot sweep
"snapshot sweep on boot: removed 0, in flight 0" were observed only on a
clean boot).

## Acceptance 3 — vuln-db age and unsupported tools visible

`GET /v1/status` on the runner and `GET /api/v1/repos/1/security` (`tooling`)
both report:

```
vuln_db: present=true schema=6 builtAt=2026-08-20T00:15:42Z ageDays=21 maxAgeDays=5 stale=true
unsupported_tools: govulncheck; Semgrep registry packs (p/*, --config auto); import-linter; cosign;
                   Infrastructure-as-code scanners (checkov, trivy config, kics); Secret scanners (gitleaks, trufflehog)
```

and the dependency_cve run row carries the refusal sentence naming
`deploy/scan-db-sync.sh`. The database was NOT refreshed for this proof
(~2 GB download); dependency_cve therefore did not produce findings here.

## Acceptance 4 — docker vs podman argv

Podman argv exercised end to end on a real podman 5.8.2 server (above),
including `--timeout=<wall+5>` from `2461d5d`. Docker argv remains unit-tested
only (`runner.test.ts`, `sandbox.test.ts`): no docker daemon on this host.

## Residual

- Docker host run of the same proof (compose.yaml with `RUNTIME=docker`,
  `SCAN_RUNNER_USER=100:101`, `CONTAINER_SOCKET_GID`) — not done here.
- `deploy/up.sh` (customer compose.yaml, real `.env`) was not the launcher
  used; demo.sh with compose.demo.yaml was. Same build targets and the same
  scan-runner/worker wiring, but up.sh's socket derivation and health wait
  were not exercised in this run.
- dependency_cve needs `deploy/scan-db-sync.sh` before it can produce
  findings; semgrep ran to completion but the fixture yields 0 findings for
  `bpm-baseline.v1.yaml`, so security-path FINDINGS (as opposed to run rows)
  are shown only by logging_hygiene and secrets (in-house, not containerised).
- Worker restart mid-scan not exercised.

## Cleanup performed

Probe directory `snap-w1727probe` and `/tmp/probe.cjs` removed from the
worker; repo 2's three deleted code_health rows were re-created by run 124
(two, see above). Demo admin password was reset (unknown after the previous
session) — it is no longer `demo-password-change-me`; `./deploy/demo.sh reset`
restores first-boot state. Stack left running.
