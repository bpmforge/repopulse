import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runDependencyTools, checkVulnDb, vulnDbDir } from './tools.js';
import { dependencyFindings } from './findings.js';

// THE LIVE HALF (W8-06).
//
// The unit tests above run against captured output, which proves the readers
// are right about a shape but not that the shape still arrives. This runs the
// real syft and the real grype, offline, under the unmodified §2.2 profile,
// against a lockfile pinning jquery 3.4.1 — a package on the CISA
// known-exploited list — and asserts the CVE by name.
//
// It is gated on the scan image AND on a synced database, because both are
// required and their absence must read as "skipped for a stated reason" rather
// than as a passing suite.

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/dependency',
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

const vulnDb = vulnDbDir();
const ready = scanImage !== undefined && checkVulnDb(vulnDb).ok;
const describeIfScannable = ready ? describe : describe.skip;

describeIfScannable('syft + grype over a real tree', () => {
  const budget = { wallClockMs: 240_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 };
  const run = async (fixture: string) =>
    await runDependencyTools({
      targetDir: path.join(FIXTURES, fixture),
      image: scanImage as string,
      vulnDb,
      budget,
    });

  it('reports CVE-2020-11023 on jquery 3.4.1, flagged as known-exploited', async () => {
    const tools = await run('vulnerable');
    expect(tools.status, tools.error ?? '').toBe('succeeded');

    const { findings } = dependencyFindings(tools.matches, tools.document!);
    const kev = findings.find((f) => f.cveId === 'CVE-2020-11023');
    expect(kev, `findings: ${findings.map((f) => f.cveId).join(', ')}`).toBeDefined();
    expect(kev!.yields?.['kev']).toBe(true);
    // The KEV floor, on real data rather than on a fixture.
    expect(kev!.severity).toBeGreaterThanOrEqual(4);
  }, 300_000);

  it('produces an SBOM worth storing — the thing security.sboms has never had', async () => {
    const tools = await run('vulnerable');
    expect(tools.document?.['bomFormat']).toBe('CycloneDX');
    expect(tools.componentCount).toBeGreaterThan(0);
  }, 300_000);

  it('reports NOTHING on the clean tree, having actually catalogued it', async () => {
    // Both halves matter. `toHaveLength(0)` alone also passes when syft
    // catalogued nothing at all, which is the failure this whole scanner is
    // built to make impossible: an empty findings list against an empty
    // component list is not a clean repository, it is a scan that did not run.
    const tools = await run('clean');
    expect(tools.status, tools.error ?? '').toBe('succeeded');
    expect(tools.componentCount).toBeGreaterThan(0);

    const { findings } = dependencyFindings(tools.matches, tools.document!);
    expect(findings.map((f) => `${f.title}`)).toEqual([]);
  }, 300_000);

  it('does not catalogue dev dependencies — a known limit, asserted on purpose', async () => {
    // The vulnerable fixture pins minimist 1.2.0 as a devDependency and syft
    // never reports it: its javascript cataloger excludes dev dependencies by
    // default, and the switch is a syft CONFIG setting, which under this
    // profile could only arrive as image ENV (the container is given no
    // environment by design). So `dev` scope never fires for npm today.
    //
    // Pinned here rather than left as a footnote: the day someone turns it on,
    // this test says so instead of a scope multiplier changing silently.
    const tools = await run('vulnerable');
    const names = (tools.document?.['components'] as { name?: string }[]).map((c) => c.name);
    expect(names).toContain('jquery');
    expect(names).not.toContain('minimist');
  }, 300_000);
});
