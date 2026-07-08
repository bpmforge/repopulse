# RepoPulse — project rules (read first, every session)

Entry point for coding agents: `MASTER_PROMPT.md` → `plan.json` → `PLAYBOOK.md`.

## Laws

1. **One ticket at a time** from `plan.json`; respect `write_scope` and
   `depends_on`. Claim = set `in_progress` + commit.
2. **Verify every external API** against real docs/node_modules before use
   (Context7 or `node -e "import ..."` export checks). Versions live in
   `docs/TECH_STACK.md`; upgrade only in lockstep and record it there.
3. **Full gate before closing any ticket**:
   `pnpm lint && pnpm typecheck && pnpm test` (workspace-wide), plus the
   ticket's own acceptance criteria. Report test counts in commit bodies.
4. **No cloning, ever** (CONSTRAINTS.md C1): all repo analysis goes through
   the `ForgeProvider` interface and our own database. The web app never
   calls a forge API on page load — it reads only our Postgres.
5. **Tenancy invariant**: every tenant-scoped table has `workspace_id`;
   every query is workspace-filtered. Tenancy tests must stay green even
   though v1 runs one workspace.
6. **Module boundaries** (ARCHITECTURE.md): `forge` / `ingest` / `metrics` /
   `analysis` / `insights` / `reports` / `auth` never import `api` or `web`.
   `metrics` and `analysis` read the DB, never the forge directly.
7. **Rate-limit budget is law**: all forge calls go through the budgeted
   client (`packages/forge`); no raw fetch/octokit calls elsewhere.
8. **LLM calls** (Tier 2/3) go through the analysis gateway only: 45000
   maxTokens on local calls, retry + warm-up for LM Studio "model crashed",
   chunked diffs (~10k-token real output cap). Tier-3 (Claude API) requires
   the repo opt-in flag and writes a data-egress audit row.
9. **Secrets**: forge tokens encrypted at rest; nothing secret in git.
10. Push `main` to both remotes after merged work: `git push origin main &&
    git push github main` (origin/Gitea may be unreachable off-LAN — GitHub
    always; note unsynced state in docs/STATUS.md when it happens).

## Map

- Founding decisions: `docs/work/FOUNDING_BRIEF.md` (D1-D7, C1-C3 — do not re-litigate)
- Architecture: `docs/ARCHITECTURE.md` · deep-dives in `docs/design/`
- Requirements: `docs/SRS.md` · stories `docs/USER_STORIES.md`
- Tests & gates: `docs/TESTING.md` · roadmap/exit criteria `docs/ROADMAP.md`
- Research (verified 2026-07-07, with URLs): `docs/research/`
- Progress ledger: `docs/STATUS.md`

## Build

pnpm monorepo: `apps/api` (Fastify), `apps/web` (React/Vite), `packages/*`
(forge, ingest, metrics, analysis, insights, reports, shared). Local dev
needs Postgres 16 + Redis (compose file, W0). `pnpm test` = vitest;
`pnpm e2e` = Playwright against seeded dev stack.
