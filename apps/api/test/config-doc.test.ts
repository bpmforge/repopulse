import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENV_REGISTRY } from '../src/routes/setup/env-registry.js';

// CONFIG DRIFT GATE (W11-02, acceptance 3).
//
// The acceptance says the reference must be "generated from or checked against
// the actual requireEnv call sites so it cannot silently drift". This is that
// check. Without it, docs/CONFIG.md is a snapshot of what was true on the day
// someone wrote it — and the person relying on it is on their own
// infrastructure, where a wrong variable looks like a broken product.

const repoRoot = new URL('../../../', import.meta.url).pathname;

/** Every env var actually read in shipped source. */
function envVarsInSource(): Set<string> {
  const out = new Set<string>();
  const grep = (pattern: string): string => {
    try {
      return execFileSync(
        'git',
        ['grep', '-hoE', '--untracked', pattern, '--', 'apps', 'packages', ':(exclude)**/*.test.ts',
          ':(exclude)**/testing/**',
          // Scan fixtures are deliberately-vulnerable sample apps, not our
          // configuration: their env reads belong to the fake app being
          // scanned, and documenting JWT_KEY as a RepoPulse knob would be a
          // lie in the customer-facing reference.
          ':(exclude)**/fixtures/**',
          ':(exclude)e2e/**',
          // Dev harnesses that are run by hand and are not shipped (W19-14: the AI-pass
          // live check reads LIVE_* knobs of its own).
          ':(exclude)apps/api/scripts/**'],
        { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (error) {
      if ((error as { status?: number }).status === 1) return '';
      throw error;
    }
  };

  for (const match of grep('process\\.env\\.[A-Z][A-Z0-9_]*').split('\n')) {
    const name = match.trim().replace('process.env.', '');
    if (name) out.add(name);
  }
  for (const match of grep("requireEnv\\('[A-Z][A-Z0-9_]*'").split('\n')) {
    const name = /'([A-Z0-9_]+)'/.exec(match)?.[1];
    if (name) out.add(name);
  }
  return out;
}

// Variables that are NOT app configuration: they belong to the platform, the
// test harness or the build, and documenting them as knobs would be wrong.
const NOT_CONFIGURATION = new Set([
  'PATH',
  'HOME',
  'CI',
  'TMPDIR',
  'REQUIRE_LIVE_INFRA',
  'E2E_API_PORT',
  'VITEST',
  'npm_lifecycle_event',
]);

describe('the configuration reference cannot silently drift', () => {
  it('documents every environment variable the shipped code reads', () => {
    const undocumented = [...envVarsInSource()]
      .filter((name) => !NOT_CONFIGURATION.has(name))
      .filter((name) => !ENV_REGISTRY.some((entry) => entry.name === name))
      .sort();

    expect(
      undocumented,
      'these variables are read in source but are not in ENV_REGISTRY, so docs/CONFIG.md does not mention them',
    ).toEqual([]);
  });

  it('has a regenerated docs/CONFIG.md — every registry entry appears in it', () => {
    const doc = readFileSync(new URL('../../../docs/CONFIG.md', import.meta.url), 'utf8');
    const missing = ENV_REGISTRY.filter((entry) => !doc.includes(`\`${entry.name}\``)).map(
      (entry) => entry.name,
    );
    expect(
      missing,
      'run: node scripts/generate-config-doc.mjs — the reference is stale',
    ).toEqual([]);
  });

  it('never prints a secret value into the reference', () => {
    const doc = readFileSync(new URL('../../../docs/CONFIG.md', import.meta.url), 'utf8');
    for (const entry of ENV_REGISTRY.filter((e) => e.secret)) {
      // The NAME appears; a value never should, and the marker says which is
      // which so a reader knows what not to paste into a support ticket.
      expect(doc).toContain(`\`${entry.name}\` 🔒`);
    }
  });

  it('says what breaks for every variable, which is the column that helps at 2am', () => {
    const silent = ENV_REGISTRY.filter((entry) => entry.ifWrong.trim().length < 20);
    expect(silent.map((e) => e.name)).toEqual([]);
  });
});
