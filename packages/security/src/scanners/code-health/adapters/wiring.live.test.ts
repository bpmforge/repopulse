import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCodeHealthTools } from '../tools.js';

// THE WIRING TEST (W9-08 carry-forward).
//
// ruff and Biome were proven to run in the sandbox when their adapters landed,
// and then called by nothing: code_health_tools never invoked them, so no ruff
// or Biome finding has ever reached the database. Their own tests passed
// throughout, because they ran the adapters directly.
//
// This asserts the thing those tests could not: that the SCANNER produces them.

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/adapters',
);

const scanImage = (() => {
  try {
    return execFileSync('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}'], {
      stdio: 'pipe',
    })
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.startsWith('localhost/repopulse/scan:'));
  } catch {
    return undefined;
  }
})();

const describeIfScanImage = scanImage ? describe : describe.skip;

/** Both fixture languages in one tree, so language routing has to choose. */
function mixedTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'w9-08-wiring-'));
  cpSync(path.join(FIXTURES, 'python'), path.join(root, 'py'), { recursive: true });
  cpSync(path.join(FIXTURES, 'javascript'), path.join(root, 'js'), { recursive: true });
  return root;
}

describeIfScanImage('code_health_tools calls its adapters', () => {
  const budget = { wallClockMs: 240_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 };

  it('returns ruff AND Biome findings from one scanner run', async () => {
    const result = await runCodeHealthTools({
      targetDir: mixedTree(),
      image: scanImage as string,
      budget,
    });

    expect(result.status, result.error ?? '').toBe('succeeded');
    const rules = result.adapterFindings.map((f) => f.nativeRule);
    expect(rules).toContain('E722');
    expect(rules.some((r) => r.startsWith('lint/'))).toBe(true);

    // Every adapter finding is namespaced by its tool, so a reader can tell
    // whose opinion they are reading and the FP rate accumulates against the
    // tool rather than against us.
    expect(result.adapterFindings.every((f) => f.ruleId.startsWith('tool.'))).toBe(true);
    expect(result.adapterErrors).toEqual([]);
  }, 300_000);

  it('stamps the adapter versions alongside lizard and jscpd', async () => {
    const result = await runCodeHealthTools({
      targetDir: mixedTree(),
      image: scanImage as string,
      budget,
    });
    expect(Object.keys(result.toolVersions).sort()).toEqual(['biome', 'jscpd', 'lizard', 'ruff']);
  }, 300_000);

  it('still returns OUR measurements — the adapters are additive', async () => {
    // A wiring change that quietly replaced the complexity findings would pass
    // the assertions above and lose the half of the scanner that already worked.
    const result = await runCodeHealthTools({
      targetDir: mixedTree(),
      image: scanImage as string,
      budget,
    });
    expect(result.metrics.ch_complexity_p90).not.toBeNull();
  }, 300_000);

  it('routes by language: a Python-only tree does not run Biome', async () => {
    const result = await runCodeHealthTools({
      targetDir: path.join(FIXTURES, 'python'),
      image: scanImage as string,
      budget,
    });
    expect(Object.keys(result.toolVersions)).toContain('ruff');
    expect(Object.keys(result.toolVersions)).not.toContain('biome');
  }, 300_000);
});
