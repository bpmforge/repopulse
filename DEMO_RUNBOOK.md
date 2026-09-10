# RepoPulse demo runbook

**Goal:** one-command customer-facing demo of clone-free GitHub org health / DD.

## Packaged demo (preferred)

```bash
cd ~/code/repopulse
./deploy/demo.sh up
```

- UI: http://localhost:8090
- Health: http://localhost:8090/healthz → 200
- Stop: `./deploy/demo.sh down`
- Reset: `./deploy/demo.sh reset`

Sign-in (packaged demo): `demo@repopulse.local` / `demo-password-change-me` (forced password change on first login is real product behaviour).

Fixture forge token for Connections:

`ghp_fake_forge_token_for_e2e_0123456789`

Then: Admin → Connections → Track repos → Admin → Sync → Org Overview fills as warehouse backfills.

## Dev demo (alternate)

```bash
pnpm bootstrap   # if documented
DEMO_MODE=1 pnpm dev
```

- UI: http://localhost:5273
- Creds (when seeded): `demo@repopulse.local` / `demo-password` (dev seed; packaged demo uses `demo-password-change-me`)

## Evidence

- Cold smoke PASS 2026-09-10 on M2: `docs/work/product-completion/evidence/demo-smoke-20260910-pass.txt`
- Earlier FAIL (postgres missing in migrate image): `docs/work/product-completion/evidence/demo-smoke-20260910.txt`

## Known eng fix for demo images

pnpm’s isolated `node_modules` means each workspace package needs its own `node_modules` in the api/worker/migrate images. Dockerfile must COPY `packages/*/node_modules` from the `prod-deps` stage (and include `packages/security` in install manifests). Without that, migrate/api crash with `ERR_MODULE_NOT_FOUND` (`postgres`, `drizzle-orm`, …).

## Gates

No public publish, production DNS, or paid SaaS accounts without Bradford OK.
