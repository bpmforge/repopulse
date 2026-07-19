# `apps/web/src/api` — typed API layer

The web app talks to the system **only** through `/api/v1` (Law 4 / ARCHITECTURE §3).

- `openapi.snapshot.json` — committed snapshot of the API's OpenAPI 3.1 document
  (`GET /api/v1/openapi.json`). Committed for determinism; the client types are
  generated from it, not from a live server at build time.
- `schema.gen.ts` — `openapi-typescript` output (`paths` interface). **Generated —
  do not edit.**
- `client.ts` — typed `fetch` wrapper; throws `ApiError` carrying the RFC 7807
  `problem+json` envelope (incl. `request_id`) on failure.
- `useApiQuery.ts` — `QueryDescriptor → useQuery/useInfiniteQuery` (staleTime 30s,
  `keepPreviousData` for the stale-chart pattern).
- `urlState.ts` — TanStack Router adapters over the canonical
  `@repopulse/shared/url-state` contract.

## Refreshing after an API route/schema change

1. Regenerate the snapshot by booting the API and dumping the spec (routes are
   assembled from zod schemas at `ready()`; no DB/Redis is queried by the dump):

   ```ts
   // scratch script, run with: node --import tsx <file>
   import { buildApp } from 'apps/api/src/app.js';
   import { createDb } from '@repopulse/shared';
   const app = buildApp({ db: createDb('postgres://placeholder@localhost/none'), /* …placeholder opts… */ });
   const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
   // write res.json() → apps/web/src/api/openapi.snapshot.json
   ```

2. Regenerate the types:

   ```bash
   pnpm --filter @repopulse/web gen:api
   ```
