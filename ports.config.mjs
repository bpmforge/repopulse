// RepoPulse local port block — the single source of truth.
//
// WHY A BLOCK, AND WHY NOT THE DEFAULTS: this machine runs more than one
// project, and the framework defaults collide with all of them. Vite's 5173,
// Node's habitual 3000 and the 3001 beside it were each already taken by
// another app, which cost a full e2e run when Playwright found 5173 occupied
// and refused to start. Defaults that every tool picks are defaults that every
// project fights over.
//
// So RepoPulse owns 33xx for services and 52xx for the dev web server. Nothing
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
};

/** `http://localhost:<port>` for a key, so callers never re-spell the host. */
export const urlFor = (key) => `http://localhost:${PORTS[key]}`;
