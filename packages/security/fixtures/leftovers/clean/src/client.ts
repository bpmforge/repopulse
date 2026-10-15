/*
 * Copyright (c) 2026 Example Corp. Licensed under the MIT License.
 * const licensed = true;
 * export default licensed;
 * module.exports = licensed;
 */
// Fixture (W18-07): near-misses every leftover rule must stay quiet on.
import fs from 'node:fs';
import crypto from 'node:crypto';

type Placeholder = 'changeme' | 'replace_me';

/**
 * Builds the client. Point it at your own host, e.g. https://api.example.com.
 *
 * @example
 * const client = createClient({ apiKey: process.env.API_KEY });
 * const items = await client.list();
 * console.info(items.length);
 */
export function createClient(opts: { apiKey?: string; baseUrl?: string }) {
  if (!opts.apiKey) throw new Error('Set YOUR_API_KEY in the environment before starting');
  if (opts.apiKey === 'changeme') throw new Error('refusing the default key');
  const base = opts.baseUrl ?? process.env.API_BASE_URL;
  // Relative paths are parsed against a dummy origin; only the path is kept.
  const path = new URL('/v1/items', 'http://example.com').pathname;
  return { base, path, kind: 'replace_me' as Placeholder };
}

export const field = { name: 'password', type: 'password', label: 'Password' };
export const phoneMask = { mask: 'xxx-xxx-xxxx' };
export const schema = { $id: 'https://example.com/schemas/item.json' };
export const note = 'The classic lorem ipsum placeholder is banned from copy.';

//   +---------+      +---------+
//   | client  | ---> | server  |
//   +---------+      +---------+

// For example, the old flow was:
// const token = await login(user);
// session.set(token);
// return session;

// eslint-disable-next-line no-console
// prettier-ignore
// @ts-expect-error -- narrowing

// Two lines of code in a comment are a note, not a block:
// retry(request);
// backoff();

export function read(path: string): Buffer {
  // Never `new Buffer(` — and never fs.exists( either.
  const raw = Buffer.from(fs.readFileSync(path, 'utf8'));
  const exists = fs.existsSync(path);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.alloc(32), Buffer.alloc(12));
  const parser = { parse: (s: string) => s.length };
  console.info('avoid new Buffer( in new code', exists, cipher, parser.parse('x'));
  return raw;
}
