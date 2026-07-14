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

## Wave-gate coverage loop (Ralph Wiggum, cap 3) + challenger

Closing a wave is not a feeling — it's this loop (pattern: bpm-opencode-experts
RALPH_WIGGUM_LOOP / CHALLENGER_PROTOCOL, productized for this board):

1. **INVENTORY** — the wave's tickets + every FR/NFR id they cite.
   `node scripts/validate-traceability.mjs` prints the map (122 ids at design time;
   the count only grows).
2. **VERIFY (objective, never vibes)** — run ALL validators: `validate-plan.mjs`,
   `validate-arch.sh`, `validate-traceability.mjs`, plus the wave's ROADMAP exit
   criteria and the TESTING.md §9 rule: every FR acceptance sketch in the wave maps
   to a named test (grep FR ids in test titles).
3. **GAP** — each uncovered row gets ONE focused `HANDOFF:` note in its ticket's
   `notes` (what's missing, where the spec lives). Fix only flagged rows; never
   re-run the whole wave.
4. **Repeat, cap 3.** An identical gap set two iterations running = no progress —
   halt and escalate to the user. Never loop past the cap.

**CHALLENGER (before the STATUS.md gate entry is written):** a fresh session/agent —
never one that implemented a ticket in this wave (maker ≠ verifier) — re-derives each
exit criterion from the docs and tries to REFUTE the evidence. Every accepted criterion
records `re-ran independently: <command, counts, exit code>`. CONTRADICTED evidence
reopens the ticket; UNVERIFIABLE criteria are listed in the gate entry, not waived
silently. Only then does the gate section land in docs/STATUS.md.

## Refusal conditions (stop and ask the user)

- A ticket seems to require cloning a repo or bypassing the budgeted client.
- Acceptance criteria conflict with the tenancy invariant or module rules.
- You need a dependency not in `docs/TECH_STACK.md` (propose it in notes
  first).
- A Tier-3 ticket would send more than diff + finding context to the Claude
  API (egress-minimization, SECURITY_CONTROLS.md).
