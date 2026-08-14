import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// CAPABILITY GATE (W12-01 acceptance 3).
//
// Everything above the ForgeProvider port must branch on CAPABILITY FLAGS, never
// on which forge it is talking to. `if (kind === 'github')` scattered through
// metrics or ingest is how a three-forge product quietly becomes a one-forge
// product with two broken ones: the GitHub path keeps working, the others rot
// silently, and nothing fails until a customer notices.
//
// The rule was being honoured by convention. This makes it fail the build,
// because convention is exactly what the last week showed does not hold.

const ROOT = new URL('../../../', import.meta.url).pathname;

// The adapters themselves obviously know their own kind; the port declares the
// union. Everything else is bound by the rule.
const ALLOWED = [
  join('packages', 'forge', 'src', 'github'),
  join('packages', 'forge', 'src', 'gitea'),
  join('packages', 'forge', 'src', 'gitlab'),
  join('packages', 'forge', 'src', 'provider.ts'),
  join('packages', 'forge', 'src', 'types.ts'),
  // THE SINGLE CONSTRUCTION SITE. Deciding which adapter to instantiate must
  // branch on the forge kind — that is the one thing a capability flag cannot
  // express, because there is no provider yet to ask. Everything downstream
  // receives a ForgeProvider and must ask its capabilities instead. Keeping
  // exactly one file on this list is what makes the rule enforceable rather
  // than aspirational; a second entry here should be argued for, not added.
  join('apps', 'api', 'src', 'routes', 'connections', 'provider-factory.ts'),
];

const SEARCH_ROOTS = [
  join('packages', 'metrics', 'src'),
  join('packages', 'insights', 'src'),
  join('packages', 'ingest', 'src'),
  join('packages', 'reports', 'src'),
  join('packages', 'analysis', 'src'),
  join('apps', 'api', 'src'),
];

// `kind === 'github'`, `provider.kind == "gitea"`, switch cases on the name…
const PROVIDER_NAME_BRANCH = /\bkind\s*===?\s*['"](github|gitea|gitlab)['"]/;

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out = out.concat(walk(full));
    } else if (full.endsWith('.ts') && !full.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

describe('capability gate (FR-FORGE-7)', () => {
  it('no module above the port branches on the provider NAME', () => {
    const offenders: string[] = [];
    for (const root of SEARCH_ROOTS) {
      for (const file of walk(join(ROOT, root))) {
        const rel = file.slice(ROOT.length);
        if (ALLOWED.some((a) => rel.startsWith(a))) continue;
        const src = readFileSync(file, 'utf8');
        src.split('\n').forEach((line, i) => {
          if (PROVIDER_NAME_BRANCH.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(
      offenders,
      'these branch on WHICH forge rather than on a capability flag — add a flag to ForgeCapabilities instead',
    ).toEqual([]);
  });

  it('every adapter declares the same capability keys, so a flag cannot be forgotten', async () => {
    const [{ GITHUB_CAPABILITIES }, { GITEA_CAPABILITIES }, { GITLAB_CAPABILITIES }] =
      await Promise.all([
        import('../src/github/provider.js'),
        import('../src/gitea/provider.js'),
        import('../src/gitlab/provider.js'),
      ]);
    const keys = (o: object) => Object.keys(o).sort();
    // A missing key reads as `undefined`, which is falsy — so a forgotten flag
    // silently disables a feature rather than failing loudly.
    expect(keys(GITEA_CAPABILITIES)).toEqual(keys(GITHUB_CAPABILITIES));
    expect(keys(GITLAB_CAPABILITIES)).toEqual(keys(GITHUB_CAPABILITIES));
  });
});
