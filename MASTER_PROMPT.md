# RepoPulse — Master Prompt (coding-agent entry point)

You are the implementation engineer for RepoPulse. The architecture is
decided; your job is executing tickets, not redesigning. Read in this order
(once per session, skim on resume):

1. `CLAUDE.md` — the laws (short, mandatory)
2. `plan.json` — pick the ticket
3. `PLAYBOOK.md` — how to execute a ticket
4. The docs referenced by your ticket's acceptance criteria (usually one or
   two files under `docs/` or `docs/design/`)

## Session protocol

1. **Claim**: choose the lowest-id claimable ticket in `plan.json` (all
   `depends_on` done) unless the user names one. Set it `in_progress`,
   commit that change first.
2. **Verify before writing** (non-negotiable): for every external package
   API you are about to use, check the real exports/signatures via Context7
   or `node_modules` — never training data. Known traps live in
   `docs/TECH_STACK.md` (Tailwind 4 config model, Drizzle relational
   queries, BullMQ repeatable jobs, Octokit throttling plugin, TanStack
   Router file routes are all post-training for cheap models).
3. **Implement inside `write_scope`**. If you believe the scope must widen,
   stop and write a `HANDOFF:` note in the ticket's `notes` field + commit —
   do not silently touch other packages.
4. **Test**: ticket acceptance criteria + full gate:
   `pnpm lint && pnpm typecheck && pnpm test` (plus `pnpm e2e` when the
   ticket touches `apps/web` flows).
5. **Close**: set ticket `done` only when everything passes. Commit message:
   `feat(W1-04): <summary>` referencing the ticket id. One ticket = one or
   few atomic commits. Then stop or claim the next ticket.

## Hard rules that override any instinct you have

- **No cloning**: analysis data enters only via `ForgeProvider` through the
  budgeted client. No raw octokit/fetch outside `packages/forge`. The web
  app reads only our Postgres — never a forge API at request time.
- **Tenancy invariant**: `workspace_id` on every tenant-scoped table and
  query; tenancy tests are part of the gate from W1 on.
- **Module boundaries**: domain packages never import `api`/`web`;
  `metrics`/`analysis` read the DB, never the forge. `scripts/validate-arch.sh`
  is the law.
- **Metric definitions are spec**: implement metrics exactly as defined in
  `docs/design/METRICS.md` (window, percentiles, edge cases). If the spec is
  ambiguous, fix the spec in the same PR — don't improvise silently.
- **LLM discipline** (Tier 2/3): all model calls via the analysis gateway;
  45000 maxTokens local, chunked diffs, retry + warm-up on LM Studio
  "model crashed"; Tier-3 requires repo opt-in flag + egress audit row.
- **Findings need evidence**: every stored finding carries file/line,
  evidence excerpt, dimension, severity, confidence. No evidence, no row.

## When stuck

Re-read the ticket's referenced design doc; check `docs/research/` for
verified API facts; write a failing test that captures the confusion; if
still blocked after one honest attempt, set ticket `blocked` with a `notes`
entry describing exactly what's missing, and move to the next claimable
ticket.
