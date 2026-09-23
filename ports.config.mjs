// RepoPulse local port block — the single source of truth.
//
// WHY A BLOCK, AND WHY NOT THE DEFAULTS: this machine runs more than one
// project, and the framework defaults collide with all of them. Vite's 5173,
// Node's habitual 3000 and the 3001 beside it were each already taken by
// another app, which cost a full e2e run when Playwright found 5173 occupied
// and refused to start. Defaults that every tool picks are defaults that every
// project fights over.
//
// So RepoPulse owns 33xx for services, 52xx for the dev web server, and the
// dev data tier sits on 15432/16379 — Postgres and Redis at a glance, but not
// the 5432/6379 that Homebrew services and every other project's compose file
// publish. A second local Postgres is the collision that costs the most,
// because the symptom is a wrong database answering, not a refused port. Nothing
// here is magic; the point is that they are OURS, they are in one file, and a
// second project's `npm run dev` cannot silently take one.
//
// Every value stays env-overridable — this changes the DEFAULT, never the
// ability to move it. Deployment ports are separate and live in
// deploy/.env.example.

export const PORTS = {
  /** Fastify API, `pnpm dev`. */
  api: Number(process.env.PORT ?? 3300),
  /** Worker /healthz. */
  workerHealth: Number(process.env.WORKER_HEALTH_PORT ?? 3301),
  /** Vite dev server. */
  web: Number(process.env.WEB_PORT ?? 5273),
  /** The e2e stack, deliberately NOT the dev ports: a `pnpm dev` left running
   *  in another terminal must not be mistaken for the API under test. */
  e2eApi: Number(process.env.E2E_API_PORT ?? 3310),
  e2eWorkerHealth: Number(process.env.E2E_WORKER_HEALTH_PORT ?? 3311),
  /** The fake forge e2e binds, which must be a known port (e2e/server.ts). */
  e2eFakeForge: Number(process.env.E2E_FAKE_FORGE_PORT ?? 9099),
  /**
   * The fake forge DEMO MODE binds (W16-29).
   *
   * It used to take port 0 — whatever the OS handed out — which was fine while
   * only the API talked to it, and wrong the moment anything else had to: the
   * worker is a separate process and cannot be told a port that is chosen after
   * it starts. Its own block, not the e2e one, so a demo left running and a
   * Playwright run do not fight over the same socket.
   */
  demoFakeForge: Number(process.env.DEMO_FORGE_PORT ?? 3309),
  /**
   * The DEMO e2e stack (W16-14), deliberately apart from both the dev ports
   * and the e2e ones.
   *
   * It has to be its own block for the same reason the e2e stack is: this
   * project boots `DEMO_MODE=1 pnpm dev`, the actual quickstart command, and a
   * demo someone left running in another terminal must neither be mistaken for
   * the stack under test nor be killed by it.
   */
  demoE2eApi: Number(process.env.DEMO_E2E_API_PORT ?? 3320),
  demoE2eWorkerHealth: Number(process.env.DEMO_E2E_WORKER_HEALTH_PORT ?? 3321),
  demoE2eFakeForge: Number(process.env.DEMO_E2E_FAKE_FORGE_PORT ?? 3322),
  demoE2eWeb: Number(process.env.DEMO_E2E_WEB_PORT ?? 5283),
  /**
   * The dev data tier's HOST ports (compose.dev.yaml publishes them on
   * loopback). Inside the compose network the services keep 5432/6379; only
   * the host side moves. `.env.example` spells the same numbers in
   * DATABASE_URL / REDIS_URL, and compose reads POSTGRES_PORT / REDIS_PORT.
   */
  postgres: Number(process.env.POSTGRES_PORT ?? 15432),
  redis: Number(process.env.REDIS_PORT ?? 16379),
};

/** `http://localhost:<port>` for a key, so callers never re-spell the host. */
export const urlFor = (key) => `http://localhost:${PORTS[key]}`;
