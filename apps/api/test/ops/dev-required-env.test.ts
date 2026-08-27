import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENV_REGISTRY } from '../../src/routes/setup/env-registry.js';

// DEV LAUNCHER DRIFT GATE (W16-18).
//
// `scripts/dev.mjs` keeps its own list of required environment variables, and
// it has to: it runs as plain node before any TypeScript is compiled, and its
// whole job is to fail with a sentence a newcomer can act on rather than a
// stack trace from inside a tsx child.
//
// The cost of that second copy came due. The list still demanded
// GITHUB_APP_CLIENT_ID/SECRET in non-demo mode long after D14 made forge
// sign-in optional, so `pnpm dev` — the command the documentation tells people
// to run — refused to start on any install without a GitHub App. Three other
// places already said it was optional (ENV_REGISTRY marks both `required:
// false`, apps/api/src/index.ts handles their absence, docs/RUNNING.md promises
// "their absence is no longer fatal"); only the launcher disagreed, and the
// launcher is the one that runs.
//
// It survived because nothing ever booted the non-demo path: every test and
// every manual pass set DEMO_MODE, which skips the branch entirely.

const repoRoot = new URL('../../../../', import.meta.url).pathname;

/** The `REQUIRED` array literal in scripts/dev.mjs. */
function devRequired(): string[] {
  const source = readFileSync(`${repoRoot}scripts/dev.mjs`, 'utf8');
  const match = /const REQUIRED = \[([\s\S]*?)\];/.exec(source);
  if (!match?.[1]) throw new Error('scripts/dev.mjs no longer declares `const REQUIRED = [...]`');
  return [...match[1].matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]!);
}

/** Everything ENV_REGISTRY says an api/worker/shared deployment cannot boot without. */
function registryRequired(): string[] {
  return ENV_REGISTRY.filter((v) => v.required).map((v) => v.name);
}

describe('scripts/dev.mjs required env (W16-18)', () => {
  it('demands nothing ENV_REGISTRY calls optional', () => {
    const optional = new Set(ENV_REGISTRY.filter((v) => !v.required).map((v) => v.name));
    const overreach = devRequired().filter((name) => optional.has(name));

    expect(
      overreach,
      'the dev launcher refuses to start without these, but ENV_REGISTRY says they are optional — ' +
        'that is how `pnpm dev` came to reject every install with no GitHub App',
    ).toEqual([]);
  });

  it('demands everything ENV_REGISTRY calls required', () => {
    // The other direction matters too: a variable the API cannot boot without,
    // missing from this list, is a stack trace from inside a tsx child instead
    // of the sentence this preflight exists to print.
    const missing = registryRequired().filter((name) => !devRequired().includes(name));

    expect(missing, 'ENV_REGISTRY requires these but the dev launcher does not check them').toEqual(
      [],
    );
  });

  it('does not require a GitHub App — install-without-a-forge is a supported install', () => {
    // The specific regression, named. D14 and W15-05 exist to make this true.
    expect(devRequired()).not.toContain('GITHUB_APP_CLIENT_ID');
    expect(devRequired()).not.toContain('GITHUB_APP_CLIENT_SECRET');
  });
});
