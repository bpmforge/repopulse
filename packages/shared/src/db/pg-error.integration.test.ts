import 'dotenv/config';
import { Writable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../index.js';
import { createLogger } from '../logger/index.js';
import { redactQueryError, safeErrorText } from './pg-error.js';

// The same guarantees as pg-error.test.ts, against a REAL failed query: the
// error drizzle and postgres.js actually build, not a hand-made look-alike.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const SENTINEL = 'SENTINEL-pg-9d41e7';

describeIfLiveInfra('a real drizzle query failure (SC-19 drizzle 0.45)', () => {
  const db: Database = createDb(databaseUrl as string);
  afterAll(async () => {
    await db.$client.end();
  });

  async function failedQuery(): Promise<unknown> {
    try {
      await db.execute(sql`select ${SENTINEL}::int`);
    } catch (err) {
      return err;
    }
    throw new Error('the query was meant to fail');
  }

  it('carries the bound value in its raw message, which is the hazard', async () => {
    expect((await failedQuery()) as Error).toHaveProperty(
      'message',
      expect.stringContaining(SENTINEL),
    );
  });

  it('safeErrorText keeps the reason and the SQLSTATE, not the statement', async () => {
    const text = safeErrorText(await failedQuery());
    // Postgres echoes the bad value in this message; it must not survive.
    expect(text).toBe('invalid input syntax for type integer: "[REDACTED]" (SQLSTATE 22P02)');
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain('Failed query');
    expect(text).not.toContain('select');
  });

  it('redactQueryError and the logger never print the statement', async () => {
    const err = await failedQuery();
    const safe = redactQueryError(err) as Error;
    const exposed = `${safe.message}\n${safe.stack}\n${JSON.stringify(safe)}`;
    expect(exposed).not.toContain(SENTINEL);
    expect(exposed).not.toContain('select $1');

    let out = '';
    const destination = new Writable({
      write(chunk, _enc, callback) {
        out += chunk.toString();
        callback();
      },
    });
    const log = createLogger({ destination: destination as unknown as pino.DestinationStream });
    log.error({ err }, 'query failed');
    log.error(err as Error);
    expect(out).toContain('SQLSTATE 22P02');
    expect(out).not.toContain(SENTINEL);
    expect(out).not.toContain('select $1');
    expect(out).not.toContain('Failed query: select');
  });
});
