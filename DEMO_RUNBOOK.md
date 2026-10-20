# RepoPulse demo runbook

**Goal:** one-command customer-facing demo of clone-free GitHub org health / DD.

Two different things are called "demo"; they are not interchangeable:

| | Trial stack (packaged) | DEMO_MODE (dev) |
|---|---|---|
| Started by | `./deploy/demo.sh up` | `DEMO_MODE=1 pnpm dev` |
| Address | http://localhost:8090 | http://localhost:5273 |
| Password | `demo-password-change-me` (forced change) | `demo-password` |
| Demo banner | no (it is the real product on fixture data) | yes ("mocked forge sign-in") |

## Trial stack (packaged, preferred)

From the root of a RepoPulse checkout:

```bash
./deploy/demo.sh up
```

- UI: http://localhost:8090
- Health: http://localhost:8090/healthz → 200
- Stop: `./deploy/demo.sh down`
- Reset: `./deploy/demo.sh reset`

Sign-in (trial stack): `demo@repopulse.local` / `demo-password-change-me` (forced password change on first login is real product behaviour).

Fixture forge token for Connections:

`ghp_fake_forge_token_for_e2e_0123456789`

Then: Settings → Connections → Track repos → Settings → Sync → Org Overview fills as warehouse backfills.

## DEMO_MODE (dev, alternate)

```bash
pnpm bootstrap   # writes .env, applies migrations, seeds the warehouse
DEMO_MODE=1 pnpm dev
```

- UI: http://localhost:5273
- Creds (when seeded): `demo@repopulse.local` / `demo-password` (dev seed; the trial stack uses `demo-password-change-me`)
- The banner says "mocked forge sign-in": the RepoPulse password sign-in is real, the forge behind it is a fake.

## Evidence

- Cold smoke PASS 2026-09-10 on M2: `docs/work/product-completion/evidence/demo-smoke-20260910-pass.txt`
- Earlier FAIL (postgres missing in migrate image): `docs/work/product-completion/evidence/demo-smoke-20260910.txt`

## Known eng fix for demo images

pnpm’s isolated `node_modules` means each workspace package needs its own `node_modules` in the api/worker/migrate images. Dockerfile must COPY `packages/*/node_modules` from the `prod-deps` stage (and include `packages/security` in install manifests). Without that, migrate/api crash with `ERR_MODULE_NOT_FOUND` (`postgres`, `drizzle-orm`, …).

## Gates

No public publish, production DNS, or paid SaaS accounts without Bradford OK.
