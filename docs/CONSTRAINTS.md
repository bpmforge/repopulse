# RepoPulse — Constraints

Traces to: `docs/work/FOUNDING_BRIEF.md`. C1–C3 are the brief's hard constraints,
expanded here; C4+ are binding operational/engineering constraints derived from D1
and bpmforge house rules. Violations block phase gates.

## C1 — No cloning (hard)

- All analysis is via forge APIs: commits, PR files/diffs, reviews, review comments,
  check runs, issues, releases, and **targeted** contents fetches (single files on
  demand, never tree walks that emulate a clone).
- Consequences that are architecture requirements, not optimizations:
  - **Rate-limit budgeter** in `ingest`: per-installation budget, split between
    backfill and live sync, GraphQL preferred for batchable history.
  - **ETag conditional requests** everywhere a resource is re-polled (304 = free).
  - **Incremental sync cursors** per repo/resource type: resumable, idempotent,
    replayable; the cursor store is the source of truth for "what we have".
- Anything requiring a working tree (full-repo SAST, build, dependency resolution
  from lockfile graphs beyond API-fetched files) is out (NON_GOALS N-1/N-2).

### C1a — Ephemeral source snapshots (exception, D8; amended 2026-10-31, D4(a))

- W8+ security scanners may fetch the forge API **tarball** through the budgeted client
  (`scan` lane) into an ephemeral, sandboxed scratch dir. Source may exist on disk
  **for the length of one scan batch (all enabled snapshot scanners over one commit)** —
  one tarball per (repo, sha) per Run-scans press or scheduled pass, shared by every
  snapshot scanner in that batch — and no longer.
- The directory is created and deleted by one bracket (`snapshotForScan`, deleted in
  `finally` on every exit path); the hourly/boot sweeper still removes any `snap-*`
  directory older than the longest allowed scan (NFR-13). Nothing persists but findings.
- Still forbidden: `git clone`, persistent checkouts or working copies, a snapshot kept
  across batches or commits, and any tarball call outside `snapshot/fetch.ts`.

## C2 — Local-LLM ops reality (hard; applies to Tier 2, v1.x)

Lessons imported from prior bpmforge projects (ThreatForge, Jarvis):

- **45,000 maxTokens** headroom on every local-LLM call (thinking models need it).
- Real usable **output ≈ 10k tokens** on qwen3.6-class models on LM Studio — diff
  review MUST be chunked; never design a prompt that expects a long single response.
- **Retry + warm-up** wrapper for transient LM Studio "model crashed"; health-probe
  hosts before dispatching a batch.
- LLM tiers are **best-effort**: queue via BullMQ, degrade to Tier 1 when hosts are
  down (RISKS R-3). Ingestion and metrics never depend on an LLM being up.

## C3 — Cheap-agent buildability (hard)

- Every doc is written to be executed by inexpensive coding agents, RetroForge
  pattern: `MASTER_PROMPT.md` → `plan.json` → `PLAYBOOK.md`.
- Requirements carry IDs (**FR-x / NFR-x**) tracing to SCOPE **S-x** and brief
  D/C items; tickets cite the IDs they implement.
- Docs are dense and unambiguous: tables over prose, acceptance criteria per ticket,
  no decision left to the executing agent that the design should have made.

## C4 — Infrastructure & deployment

- **Single-node PostgreSQL 16 + Redis** on bpmforge infra; no managed cloud services.
  Design for it: replayable ingestion (cursors), nightly backups, Redis is
  queues-only and flushable (RISKS R-10).
- **Podman** deployment (compose file in repo) to `repopulse.bpmforge.com` (D1).
- Dual remotes: Gitea `origin` + GitHub, branch `main`, feature branches per SDLC.

## C5 — GitHub OAuth app registration

- A GitHub OAuth app must be registered (callback `https://repopulse.bpmforge.com/…`,
  plus a localhost dev app). Prerequisite ticket in wave 0; scopes are the minimum
  that satisfy D6 login + org read (`read:org`, `repo` read surface — final scope
  set fixed in the auth design doc).
- Webhook secrets per installation; signature verification mandatory.

## C6 — Data egress (hard)

- **No customer data leaves bpmforge infra**, with exactly one exception: **opt-in
  Tier-3 Claude API calls** (D2), enabled per repo/PR by an admin.
- What Tier-3 sends must be **minimized and documented**: the relevant diff chunk,
  minimal surrounding file context fetched via API, and the dimension checklist —
  never tokens/secrets, never whole-repo context, never other repos' data. The exact
  payload schema is a required section of the analysis design doc, and every Tier-3
  call is logged (repo, PR, payload byte size, timestamp) for audit.
- Tier-2 traffic stays on the LAN (LM Studio hosts); telemetry/analytics off by
  default.

## C7 — Engineering standards

- **TypeScript strict mode** across the monorepo (`"strict": true`, no `any`
  escapes without justification); Node 22, pnpm workspaces per the brief stack.
- **Tests alongside code**: every new service/module ships its `.test.ts` in the
  same ticket — vitest for unit/integration, Playwright for E2E. Full suite runs
  after multi-file changes; pass count reported.
- Module boundaries are fixed by the brief (`forge · ingest · metrics · analysis ·
  insights · reports · auth · api · web`); cross-module imports only through
  declared interfaces.
- Every tenant-scoped table carries `workspace_id` (D1); tenancy tests enforce it
  (RISKS R-7).
