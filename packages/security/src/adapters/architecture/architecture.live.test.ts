import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSandboxArgs } from '../../../sandbox/profile.js';
import { dependencyCruiserAdapter, grimpAdapter, type GraphAdapter } from './adapters.js';
import { detectArchitecture } from './graph.js';
import { loadArchitecturePack } from './pack.js';
import { listSnapshotFiles, runArchitectureTools } from './tools.js';

// The live half of W10-03: both adapters ACTUALLY RUN, in the real sandbox,
// over fixtures with real cycles in them. A parser test proves we can read a
// document; only this proves the tool produces one under --network=none with
// nothing installed, which is the admission filter's entire claim.

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test/fixtures/architecture',
);
const PACK = loadArchitecturePack();

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

describeIfScanImage('import-graph adapters, actually run', () => {
  const budget = { wallClockMs: 180_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 };

  function run(adapter: GraphAdapter, dir: string): string {
    const ctx = { mountPath: '/scan', files: listSnapshotFiles(dir) };
    try {
      return execFileSync(
        'podman',
        buildSandboxArgs({
          image: scanImage as string,
          snapshotDir: dir,
          command: adapter.command(ctx),
          budget,
          writablePaths: ['/opt/opengrep/.opengrep'],
        }),
        { stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 },
      ).toString();
    } catch (error) {
      // depcruise exits non-zero when it has something to say; that is a
      // successful run.
      return (error as { stdout?: Buffer }).stdout?.toString() ?? '';
    }
  }

  it('dependency-cruiser finds the seeded JS cycle with no network', () => {
    const dir = path.join(FIXTURES, 'js');
    const ctx = { mountPath: '/scan', files: listSnapshotFiles(dir) };
    const { graph, skipped } = dependencyCruiserAdapter.parse(run(dependencyCruiserAdapter, dir), ctx);

    expect(graph.edges.size).toBeGreaterThan(10);
    const { findings } = detectArchitecture(graph, PACK);
    const cycle = findings.find((f) => f.ruleId === 'architecture.cycle')!;
    expect(cycle.members.sort()).toEqual(['src/orders.js', 'src/pricing.js']);
    // The tool resolved every local import; anything it could not is reported.
    expect(skipped).toEqual([]);
  }, 300_000);

  it('sees the god module and the orphan cluster in the same JS graph', () => {
    const dir = path.join(FIXTURES, 'js');
    const ctx = { mountPath: '/scan', files: listSnapshotFiles(dir) };
    const { graph } = dependencyCruiserAdapter.parse(run(dependencyCruiserAdapter, dir), ctx);
    const { findings } = detectArchitecture(graph, PACK);

    expect(findings.find((f) => f.ruleId === 'architecture.god_module')?.members).toEqual([
      'src/hub.js',
    ]);
    const orphan = findings.find((f) => f.ruleId === 'architecture.orphan_cluster');
    expect(orphan?.members.sort()).toEqual([
      'src/island-one.js',
      'src/island-three.js',
      'src/island-two.js',
    ]);
  }, 300_000);

  it('grimp graphs Python with an UNINSTALLED third-party import present', () => {
    // This is the admission-filter claim in one assertion: no pip install, no
    // network, and an import of `requests` that resolves to nothing does not
    // stop the graph being built.
    const dir = path.join(FIXTURES, 'py');
    const ctx = { mountPath: '/scan', files: listSnapshotFiles(dir) };
    const { graph, skipped } = grimpAdapter.parse(run(grimpAdapter, dir), ctx);

    expect(skipped).toEqual([]);
    const { findings } = detectArchitecture(graph, PACK);
    const cycle = findings.find((f) => f.ruleId === 'architecture.cycle')!;
    expect(cycle.members.sort()).toEqual(['shop.cart', 'shop.checkout']);
    // The finding points at a real file, so the hotspot lookup that prices it
    // has something to match on.
    expect(cycle.file).toBe('shop/cart.py');
  }, 300_000);

  it('runs both adapters in one pass and stamps their versions', async () => {
    const result = await runArchitectureTools({
      targetDir: path.join(FIXTURES, 'js'),
      image: scanImage as string,
      budget,
    });

    expect(result.status).toBe('succeeded');
    expect(result.toolVersions).toEqual({ dependency_cruiser: '17.4.3' });
    // The Python adapter did not APPLY to a JS-only tree, which is not the
    // same as having failed — reported separately for exactly that reason.
    expect(result.notApplicable).toEqual(['grimp']);
    expect(result.findings.length).toBeGreaterThan(0);
  }, 300_000);

  it('a failing tool FAILS the scan rather than reporting a clean tree', async () => {
    const broken: GraphAdapter = {
      ...dependencyCruiserAdapter,
      command: () => ['depcruise', '--not-a-flag'],
    };
    const result = await runArchitectureTools({
      targetDir: path.join(FIXTURES, 'js'),
      image: scanImage as string,
      budget,
      adapters: [broken],
    });
    expect(result.status).toBe('failed');
    expect(result.findings).toEqual([]);
    expect(result.toolErrors.length).toBeGreaterThan(0);
  }, 300_000);
});
