# RepoPulse — continuation handoff (2026-08-13)

Read this first in a fresh session. It is written to be sufficient on its own:
what the product is, what state it is in, the traps that will waste your time,
and the exact next task.

## The product

**RepoPulse** — `~/Code/repopulse`. Clone-free repository health, code-quality
and delivery-performance monitoring. It connects to a customer's forge over the
API (**never `git clone`**, Law 4 / C1), warehouses the metadata in its own
Postgres, and serves a drill-down dashboard plus a report center.

**MVP definition (D1a + D3a, founder, 2026-08-12/13):** *a customer runs
RepoPulse in their own container system and points it at their own repositories
— GitHub, GitLab or Gitea.* Consequences already recorded in
`docs/work/FOUNDING_BRIEF.md`:

- Self-hosting **is** the MVP. bpmforge's own prod deploy (W7-05/06/07) is
  dogfood, **not** a launch gate.
- Multi-forge **is** the MVP. Gitea (W7-02) is in scope; **N-6 is graduated for
  GitLab** (W12-01). Bitbucket remains a non-goal.
- **"Fixes" means recommend + verify, never write** (D9a). N-3 is not
  graduated, C5/SC-25 read-only scopes stand. A ticket that writes to a
  customer repo is invalid — reject at review.
- **A GitHub App is NOT required.** `auth_kind: 'pat'` works and the Admin UI
  sends it. The App is the richer path (org webhooks, rate limits), not a gate.

**Remaining MVP: ~15 tickets / 60 points** of 324 open. The rest (W6 LLM, W8
security, W9 code health, W10 registers, most of W5) is explicitly post-MVP.

## State right now

- Branch **`feat/w12-03-wire-processors`**, 4 commits ahead of `main`, pushed to
  both remotes, working tree clean. Merge it when W12-03 closes, or merge now if
  you prefer — it is green.
- Board: **49 done / 2 in progress / 67 todo** (`plan.json` is the source of
  truth; `docs/STATUS.md` carries the narrative).
- Gate: lint 0, typecheck 0, **465 unit tests**, **39 e2e**, all exit 0.

### What genuinely works

All six screens, navigable and deep-linkable: Org Overview → Repo Detail (4
tabs) → PR list → PR detail → file drill-down, plus My Focus and Admin
(Connections + repo picker, Sync, Members). Live SSE. WCAG AA in both themes
with a standing axe scan on populated routes. Containerised: five services, one
`compose up`, verified serving. Connect flow proven end to end with a PAT
against a fake forge — bad tokens rejected, credential stored as a fingerprint,
egress guard clean.

### What does NOT work, and it is the important part

**Ingestion has never written a row.** W2 (ingestion, 25 pts) and W3 (metrics,
45 pts) are code-complete and fully unit-tested, and until this week none of it
was registered in a production entrypoint. Today's dashboard is a view over a
warehouse the **seeder** fabricates — which is exactly why it has always looked
healthy.

## THE NEXT TASK (W12-03) — one precise symptom

Processors are now registered (`apps/api/src/workers/processors.ts`: backfill,
delta, snapshot). Driving the real operator flow against the fake forge:

- The **plan job COMPLETES**, returning `{planned: 5, deferredToEnrich: 1}`.
  So credential decryption, the budgeted provider, repo resolution, the planner
  and the fan-out all work.
- The **five per-entity jobs go straight to BullMQ's `delayed` set and never
  execute.** `completed=1` (the plan), `failed=0`, `delayed=5`.
- `processPlan` adds them with a `jobId` and **no `delay` option**, so the delay
  is not coming from the call site. Look at `createQueue`'s defaults in
  `packages/ingest/src/queues/factory.ts` and the topology's
  `QUEUE_PRIORITY`/default job options.

Reproduce it in ~2 minutes:

```bash
cd ~/Code/repopulse
export PATH="$(ls -d ~/.local/share/fnm/node-versions/v22*/installation/bin | sort -V | tail -1):$PATH"
podman compose -f compose.dev.yaml up -d postgres redis    # data tier MUST be up
set -a; . ./.env; set +a
WORKER_HEALTH_PORT=3098 FORGE_BASE_URL=http://127.0.0.1:9099 \
  pnpm --filter @repopulse/api exec tsx src/workers/index.ts &
E2E_FAKE_FORGE_PORT=9099 E2E_API_PORT=3011 pnpm e2e --grep "operator can connect and then select"
# then inspect: repos row stays pending_backfill with 0 commits
podman exec -e PGPASSWORD=repopulse_dev_password repopulse-postgres \
  psql -U repopulse -d repopulse -tc "select name, sync_status from public.repos where org='fixture-org';"
```

When it lands, the assertion to write is: `fixture-org/alpha-service` gains
commits/PRs and leaves `pending_backfill`. Then shrink `KNOWN_INERT` in
`apps/api/test/wiring.test.ts` — the gate fails if you forget.

**Also decide while you are there:** a 404 from the forge currently produces a
**completed** job with no error and no cursor. Defensible for a genuinely empty
repo, indistinguishable from a broken endpoint.

## Traps that will cost you an hour each

1. **Node 22 via fnm, pnpm 9.15.9.** `npm test` under another Node major fakes
   failures. Always prefix PATH as above.
2. **The data tier must be up** or ~33 test files fail with
   `ECONNREFUSED :5432` and it reads like broken code.
3. **Port 3000 is occupied** on this machine by an unrelated `next-server`. Use
   `E2E_API_PORT=3011` for e2e. `compose.dev.yaml` and `deploy/compose.yaml` are
   separate stacks; the deploy one publishes only web on `127.0.0.1:8099`.
4. **Check exit codes, not summary lines.** Vitest printed
   `Tests 463 passed` while exiting 1 (unhandled Redis EPIPE after the run).
   `grep "Tests "` is not a pass check.
5. **Don't run `pnpm test` and `pnpm e2e` concurrently** — same database, and
   e2e's globalSetup wipes and reseeds it.
6. **`podman compose up -d --build` does not recreate running containers.**
   `down` first or you will test the old image (this bit me).

## The pattern that has cost the most

**Four times this week, code marked "done" was never registered in a production
entrypoint** — SSE events (W4-18), connections/sync/webhooks (W4-19), and every
queue processor (W12-03). Each was found *by accident*, and the suite was green
throughout, because unit tests mount the subject into a throwaway scope and
nothing exercises the production wiring.

`apps/api/test/wiring.test.ts` now fails the build for both cases and is
two-directional (landing a processor without removing its `KNOWN_INERT` entry
also fails). **Treat `plan.json` "done" as "code written and unit-tested", not
"reachable in production", until the gate says otherwise.**

## Founder-only (Brad)

1. **A forge token** — a PAT is enough, no App needed. Paste into
   `deploy/.env`; it turns the last unknown into a confirmation.
2. **W11-04 licensing/distribution** — blocks publishing any image. Nothing is
   published yet; repo has no LICENSE and `package.json` is `private: true`.
3. **Ratify the re-sequence** — W7-05/06/07 off the MVP path (dogfood, not gate).

## Where the truth lives

`plan.json` (board) · `docs/STATUS.md` (narrative, newest entries at the end) ·
`docs/work/FOUNDING_BRIEF.md` (D1a/D3a/D9a amendments) · `docs/INSTALL.md`
(customer install) · `apps/api/test/wiring.test.ts` (what is actually wired).
