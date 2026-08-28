import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import findingsRoutes from './index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';

// GET /findings/:id — the guards (W16-32).
//
// The endpoint exists so a LINK to a finding opens it whatever the reader's
// filters are; the happy path is covered end to end in e2e/findings.spec.ts,
// against a real seeded warehouse.
//
// What is asserted HERE is what a stub db can prove honestly: the two ways in
// are refused before any query runs. A no-session request must not reach the
// database at all, and a non-numeric id must be a 400 rather than a query for
// `NaN` — which Postgres answers with an error a user would see as a 500.
//
// NOT asserted here, and said plainly rather than implied: the tenancy 404.
// That needs a finding in a second workspace, and therefore the whole
// workspace → user → connection → repo → finding chain (repos.connection_id is
// NOT NULL), which is the cost W16-10 and W16-17 are both about. The route
// filters on workspace_id the same way every other route in this file does,
// and returns 404 rather than 403 so a link cannot be used to probe for ids.

describe('GET /findings/:id refuses before it queries (W16-32)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(errorEnvelopePlugin);
    // A db that THROWS if touched. If a guard ever stops guarding, this fails
    // loudly instead of passing against a lenient stub.
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error('the database must not be reached before the guards pass');
        },
      },
    ) as never;
    await app.register(findingsRoutes, { db });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('401s with no session, without reaching the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/findings/1' });
    expect(res.statusCode).toBe(401);
  });

  it('400s on an id that is not a number, rather than querying for NaN', async () => {
    // `request.workspace` is undefined here too, so the 401 fires first — the
    // point of this case is the route with a session, below.
    const withSession = Fastify();
    await withSession.register(errorEnvelopePlugin);
    withSession.addHook('onRequest', async (request) => {
      request.workspace = { id: 1, slug: 't', name: 't' };
    });
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error('the database must not be reached for an invalid id');
        },
      },
    ) as never;
    await withSession.register(findingsRoutes, { db });
    await withSession.ready();

    // A float too, not just a word: Number('1.5') is a number and would sail
    // past a `Number.isNaN` check into a query for a row id that cannot exist.
    // '1e3' is deliberately NOT here: Number('1e3') is 1000, so the route
    // treats it as finding 1000. Mildly surprising in a URL and harmless, and
    // rejecting it would mean diverging from the `Number.isInteger(Number(x))`
    // shape every other id-taking route in this app uses — a consistency worth
    // more than the edge case.
    for (const bad of ['abc', '1.5', '-']) {
      const res = await withSession.inject({ method: 'GET', url: `/findings/${bad}` });
      expect(res.statusCode, `id=${bad}`).toBe(400);
    }
    await withSession.close();
  });
});
