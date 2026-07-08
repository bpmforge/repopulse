# RepoPulse Playbook — ticket execution discipline

Companion to `MASTER_PROMPT.md`. That file says *what governs you*; this one
says *how a ticket flows*. Ticket board: `plan.json` (schema note at top).

## Phase order and gates

Phases follow `docs/ROADMAP.md`. **Gate rule**: no ticket from wave N+1
starts until the wave-N exit criteria in ROADMAP.md pass and are recorded in
`docs/STATUS.md`. Exception: W0-* infra tickets are always claimable.

## Per-ticket loop (the micro-loop)

```
claim → read design doc(s) → verify external APIs → write failing test(s)
     → implement → acceptance green → full gate green → commit → close
```

- **Tests first where testable-first**: metric computations (fixture
  histories in `packages/metrics/fixtures/`), ForgeProvider contract tests
  (recorded GitHub API fixtures — never live calls in CI), ingest cursor
  logic, finding dedup. For dashboard tickets, acceptance = Playwright
  assertions on the seeded dev stack plus a manual checklist in the commit
  body.
- **Recorded fixtures, not live APIs**: CI must never hit github.com. W0
  ships the fixture recorder; every ForgeProvider method gets contract
  tests against recorded responses (including 304, 202-retry, truncated-diff
  and rate-limit-header cases).
- **Micro-commits**: commit at each stable point. Never leave the tree red
  overnight.
- **Migration tickets**: Drizzle migration + rollback note + tenancy check
  (`workspace_id` present and indexed on new tenant-scoped tables).

## Testing tiers (from docs/TESTING.md)

| Tier | Runs | Gate |
|---|---|---|
| Unit (vitest) + metric fixture vectors | every commit (CI) | must pass |
| ForgeProvider contract tests (recorded fixtures) | every commit | must pass |
| API integration (Fastify inject + test DB) | every commit | must pass |
| Tenancy isolation suite | every commit from W1 | must pass |
| Playwright e2e (seeded stack) | pre-merge on web tickets + nightly | must pass |
| Backfill soak (synthetic 500-PR repo) + budget assertions | pre-wave-gate | regression blocks gate |

## Git

- Branch per ticket: `feat/<ticket-id>-<slug>` off `main`; merge back with
  `--no-ff` after gates pass. Small doc-only fixes may go straight to main.
- Push after every merged ticket: `git push origin main && git push github main`
  (origin = Gitea, may be offline off-LAN — push github always; sync origin
  when reachable).
- Commit trailer: `Co-Authored-By:` line naming your model.

## Status reporting

After each merged ticket append one line to `docs/STATUS.md`:
`2026-07-07 W1-02 done — <one-line result, test counts>`. At wave gates,
write a short gate section (criteria → evidence). This file is how humans
resume the project cold.

## Refusal conditions (stop and ask the user)

- A ticket seems to require cloning a repo or bypassing the budgeted client.
- Acceptance criteria conflict with the tenancy invariant or module rules.
- You need a dependency not in `docs/TECH_STACK.md` (propose it in notes
  first).
- A Tier-3 ticket would send more than diff + finding context to the Claude
  API (egress-minimization, SECURITY_CONTROLS.md).
