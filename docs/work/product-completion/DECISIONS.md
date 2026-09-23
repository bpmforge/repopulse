# Product-completion decisions (RP-02)

Recorded 2026-09-08 while importing the standalone-product handoff
(`IMPLEMENTATION-PLAN.md`, RP-01–RP-34) into this repository's board as wave
**W17**. This file is the RP↔board index and the record of what the handoff
changes, keeps, and parks.

## D15 — The product-completion handoff executes D1a; it does not replace it

**Decision.** The handoff's direction — *a customer installs the container
stack, signs in, connects a forge, and gets evidence-backed review* — is
already this project's governing decision. **D1a (2026-08-12, sharpened
2026-08-13) made the delivery model customer-hosted and declared self-hosting
the MVP rather than a packaging follow-on.** RP-01–RP-34 are the execution plan
for D1a, not a new direction.

**What this corrects is documentation lag, not the decision.** `docs/VISION.md`,
`docs/DEPLOYMENT.md` and `docs/SCOPE.md` still describe RepoPulse as
"internal-only in v1" on `repopulse.bpmforge.com`. That phrasing predates D1a
and contradicts it. It is superseded here; the bpmforge deployment is the
**dogfood install**, not the product.

**Explicitly retained, unchanged and still binding:**

- The tenancy invariant — `workspace_id` on every tenant-scoped table, every
  query workspace-filtered, tenancy tests in the gate (D1, CLAUDE.md law 5).
- C1 no-cloning and the C1a tarball exception (CLAUDE.md law 4).
- Module boundaries, the budgeted forge client, and the analysis-gateway rule
  for all LLM calls (CLAUDE.md laws 6, 7, 8).
- D9a: RepoPulse **recommends and verifies; it never writes**. No branch, no
  patch, no PR comment. A ticket that writes to a customer repository stays
  invalid.
- D10 (licensing): proprietary, and **nothing goes public until a clean
  self-hosted install is proven end to end**. This is why RP-28 stops at a
  local image archive and RP-34 stops before publishing.
- D14: standalone auth, forge sign-in demoted to one option.

**Authority.** The handoff is a user instruction and D1a is a founder decision;
they agree. Nothing here re-opens a locked founding decision — where the two
touch the same subject (distribution), D1a already says what the handoff says.

## The RP → board mapping

RP-*nn* maps to **W17-*nn*** one-for-one, all 34, phase 17, 154 points. The
board ticket is an index into `IMPLEMENTATION-PLAN.md` §5, which holds the
authoritative steps; tickets carry scope, dependencies and acceptance criteria
but deliberately do not restate the plan.

Dependencies mirror the plan's own `Depends on:` lines, so the board's wave gate
and the handoff's numeric order cannot disagree.

## Validator repairs (not rule-bending)

`node scripts/validate-plan.mjs` **exited 1 at baseline** with 59 errors and
could not print a claimable set. Two defects, both pre-dating any RP work:

1. **Wave range lagged the board.** The id pattern allowed `W0`–`W15` while a
   complete 59-ticket W16 was on the board and shipped. Every W16 ticket failed
   the id check, and because that check `continue`s, *every other check was
   silently skipped for the whole wave.* Widened to `W0`–`W17`.
2. **`shared` was not a valid module.** Six W16 tickets already declared it and
   `packages/shared` ships as `@repopulse/shared` — it is named in CLAUDE.md's
   own build map. Added to `MODULES`.

Fixing (1) unmasked what it had been hiding: eight further violations that had
never been evaluated. Six were the missing `shared` module; two were sizing
violations on `W16-34` and `W16-59`.

The plan forbids "editing validator rules to fit this document" (RP-02 step 2).
These are not that. Both repairs make the validator describe the board as it
already was, and both were needed before a single RP ticket existed. The
guardrails themselves — Fibonacci points, 2–5 acceptance criteria, dependency
and cycle checks, the wave gate — are untouched.

**Warnings left standing:** 18 sizing warnings on already-done tickets. By
design these degrade from error to warning once a ticket closes, because the
board is then a historical record and editing the numbers would falsify the
ledger. They are not suppressed.

## Reconciled tickets

| Ticket | Was | Now | Why |
|---|---|---|---|
| `W16-34` Full-suite runs fail intermittently under memory pressure | todo | **blocked** | Superseded by **W17-03** (RP-03), which owns the root cause. Deliberately not marked done — it was never diagnosed. Its nine notes are the best evidence in the repository and are RP-03's starting point. |
| `W16-09` Provider auth beyond API keys (Vertex, Bedrock, Copilot) | todo | **blocked** | Explicitly out of release scope (plan §1: "unfinished non-API-key model authentication"). API-key providers ship; these do not. Parked, not abandoned. |
| `W11-01` Portable container images + generic compose artifact | blocked | **blocked** | Stays blocked. **W17-28** (RP-28) produces the evidence that can close it. |
| `W11-05` Self-host smoke: full customer journey on a clean host | blocked | **blocked** | Stays blocked. **W17-30** (RP-30) produces the evidence that can close it. |

### What W16-34 already ruled out

RP-03 must not re-derive this. W16-34 measured the data tier and **eliminated
it**: Redis `maxclients` 10000 with 1 connected, `timeout 0` (never drops an
idle client), `rejected_connections` 0 across 9,322 connections that day,
`used_memory` 2.5M against no `maxmemory`; postgres 84MB and redis 39MB of an
8.3GB VM. The live symptom is an ioredis `write EPIPE` — a client- or host-side
socket teardown, pointing at the Podman VM's networking or the host. Start
there.

## Internal tasks that are not customer-release blockers

The plan (RP-02 step 3) requires this to be explicit, so that legacy blocked
waves do not become an undocumented process exception.

| Ticket | Blocks this release? | Reason |
|---|---|---|
| `W7-05`, `W7-06` Production containers and prod deploy runbook | **No** | D1a: bpmforge's own production deployment is the dogfood install, explicitly *not* a launch gate. The gate is that a customer can stand it up — RP-28/RP-30. |
| `W7-07` Production GitHub App + webhook + prod OAuth registration | **No** | A specific operational integration for one operator's install. A customer registers their own. D14 also removed forge sign-in as a requirement. |
| `W14-01` First real Gitea ingestion against `git.bpmforge.com` | **No, but** | Not required of every customer. RP-30 step 3 still needs *some* authorized real-forge run; if credentials are unavailable that part is recorded BLOCKED, never substituted with fixture data. |
| `W14-03` Move CI onto Gitea Actions with a local runner | **No** | Internal CI topology. CI has never run on this project — every gate is local, and RP-34 requires local evidence against the final commit regardless. |
| `W12-10` Provision Postgres + Redis in CI | **No** | Same; already superseded on the board. |

## Release phase gates

This release's gate is the handoff's own §6 acceptance matrix, evidenced at the
**final commit** by RP-34 — not the historical wave-exit criteria in
`docs/ROADMAP.md`, which describe waves that closed months ago.

W17 is claimable under the ordinary wave rule: `blocked` does not hold the gate
closed (established W7-09, 2026-08-19), `todo` does. With `W16-09` and `W16-34`
parked, W16 no longer holds W17 shut, and W17's own `depends_on` chain enforces
the handoff's numeric order.

## Known numbering collision (not fixed here)

`docs/work/FOUNDING_BRIEF.md` uses **D10 twice** — the decision table's D10 is
"CVE validation & VEX", and a later section's D10 is "Licensing and
distribution". Both are referenced elsewhere by number. Recorded so a reader is
not misled; renumbering a founding decision is out of scope for this handoff.
