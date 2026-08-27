import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// LOGGING DRIFT GATE (W16-18).
//
// The worker had NO logger. Every operational line — including the gateway
// health line, the most useful diagnostic it emits — went to `console.log`,
// which means:
//
//   it is not structured, so an aggregator sees free text
//   it ignores LOG_LEVEL, so it cannot be turned down or up
//   it never reaches the SC-2 redaction stream hook in createLogger
//
// That last one is the one that matters. `reportGatewayHealth` prints provider
// BASE URLS, so a vendor that carries its key in a query string would have had
// it printed in clear, and the redaction that exists precisely to stop that
// would never have run.
//
// This test is what stops it coming back, one convenient console.log at a time.

const repoRoot = new URL('../../../../', import.meta.url).pathname;

/** Shipped source only — tests, CLIs and scripts may print to a terminal. */
function runtimeSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'cli') continue;
      out.push(...runtimeSources(full));
    } else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Entry points that legitimately talk to a terminal.
 *
 * `demo.ts` prints the banner and the demo credentials for a person watching a
 * terminal; `migrate.ts` is a one-shot command. `index.ts` prints the env
 * validation failures BEFORE any logger exists and then exits — routing that
 * through pino would be actively wrong, since the reader is a person on a fresh
 * install staring at a terminal and the process is about to die.
 *
 * All three are things a HUMAN reads on stdout, not events an operator greps
 * months later — which is the line this gate is actually drawing.
 */
const TERMINAL_ENTRYPOINTS = ['src/demo.ts', 'src/migrate.ts', 'src/index.ts'];

describe('runtime logging goes through pino (W16-18)', () => {
  it('no console.log/error/warn in shipped API or worker source', () => {
    const offenders: string[] = [];

    for (const file of runtimeSources(join(repoRoot, 'apps/api/src'))) {
      const rel = file.slice(file.indexOf('apps/api/') + 'apps/api/'.length);
      if (TERMINAL_ENTRYPOINTS.includes(rel)) continue;

      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        // Statement position only: the word appears in prose comments all over
        // this codebase, including in the note above this test.
        if (/^\s*console\.(log|error|warn)\s*\(/.test(line)) {
          offenders.push(`${rel}:${i + 1}`);
        }
      });
    }

    expect(
      offenders,
      'use the pino logger — console.* skips LOG_LEVEL and the SC-2 redaction hook',
    ).toEqual([]);
  });

  it('the worker builds a named logger', () => {
    // Named, because a deployment runs the API and the worker side by side and
    // "which process said this" is the first question about any line.
    const worker = readFileSync(join(repoRoot, 'apps/api/src/workers/index.ts'), 'utf8');
    expect(worker).toMatch(/createLogger\(\{\s*name:\s*'repopulse-worker'\s*\}\)/);
  });
});
