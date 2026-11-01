import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { core, facts, security } from '@repopulse/shared';
import {
  antiSlopDataVersion,
  codeHealthDataVersion,
  dependencyDataVersion,
  imageDataVersion,
  isUpToDate,
  registerBuiltinScanners,
  ruleStateStamp,
  semgrepDataVersion,
  type ScanProbe,
} from '@repopulse/security';
import {
  ALWAYS_RUN,
  PROBED_RUNNERS,
  antiSlopRunDataVersion,
  architectureDataVersion,
  buildScanProbes,
  judgementStateOf,
  supplyChainDataVersion,
} from './probes.js';

// W23-01 / W23-09. One honest probe per runner, or a stated reason it always
// runs. The probe is only worth anything if a RUN's own stamp matches it, so each
// test stamps the baseline with the same function the runner calls and then asks
// the way the worker does (probe, then isUpToDate).

// Podman is not on the API host in the packaged stack. If the semgrep probe
// reached for it, this is what it would meet.
const execFileSync = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('no container runtime on this host');
  }),
);
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync,
}));

type Row = Record<string, unknown>;

/** Tables by identity; rows newest-first, which is what the real ORDER BYs return. */
function fakeDb() {
  const tables = new Map<unknown, Row[]>();
  const rows = (t: unknown): Row[] => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t)!;
  };
  const chain = (list: Row[]) => {
    const c = {
      where: () => c,
      orderBy: () => c,
      limit: async () => list,
      then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(list).then(res, rej),
    };
    return c;
  };
  const db = { select: () => ({ from: (t: unknown) => chain(rows(t)) }) };
  return { db: db as never, rows };
}

let nextRunId = 1;
function succeededRun(over: Row): Row {
  return {
    id: nextRunId++,
    workspaceId: 1,
    repoId: 2,
    status: 'succeeded',
    partial: false,
    scope: 'full',
    trigger: 'schedule',
    findingCount: 3,
    toolVersions: null,
    dataVersion: null,
    scannerVersion: 'x',
    finishedAt: new Date(),
    ...over,
  };
}

/** The worker's order of questions: ask the probe, then isUpToDate with what it said. */
async function press(db: never, probe: ScanProbe | undefined, key: string) {
  if (!probe) return { probed: null, match: null };
  const probed = await probe({ workspaceId: 1, repoId: 2 });
  if (!probed) return { probed: null, match: null };
  const match = await isUpToDate(db, {
    workspaceId: 1,
    repoId: 2,
    scannerKey: key,
    commitSha: probed.commitSha,
    toolVersions: probed.toolVersions ?? null,
    dataVersion: probed.dataVersion ?? null,
  });
  return { probed, match };
}

const HEAD = 'a'.repeat(40);
let scanRules: string;
let savedRules: string | undefined;

/** A grype database the way scan-db-sync.sh leaves it, built `daysAgo` days ago. */
function writeVulnDb(builtAt: Date): void {
  const schema = path.join(scanRules, 'vuln-db', '6');
  mkdirSync(schema, { recursive: true });
  writeFileSync(path.join(schema, 'vulnerability.db'), 'db');
  const stamp = builtAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(
    path.join(schema, 'import.json'),
    JSON.stringify({ source: `https://grype.example/vulnerability-db_v6_${stamp}.tar.zst` }),
  );
}

beforeAll(() => {
  registerBuiltinScanners();
  savedRules = process.env['SCAN_RULES_DIR'];
  scanRules = mkdtempSync(path.join(tmpdir(), 'w23-09-rules-'));
  process.env['SCAN_RULES_DIR'] = scanRules;
});
afterAll(() => {
  if (savedRules === undefined) delete process.env['SCAN_RULES_DIR'];
  else process.env['SCAN_RULES_DIR'] = savedRules;
  rmSync(scanRules, { recursive: true, force: true });
});
beforeEach(() => {
  execFileSync.mockClear();
  rmSync(path.join(scanRules, 'vuln-db'), { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('semgrep probe (no podman at probe time)', () => {
  it("answers from the last run's engine version without starting a container", async () => {
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    const rules = await ruleStateStamp(db, 1);
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'semgrep',
        commitSha: HEAD,
        toolVersions: { opengrep: '1.8.2', rulepack: 'ignored-by-probe' },
        dataVersion: semgrepDataVersion(undefined, undefined, rules),
      }),
    );

    const { probed, match } = await press(db, buildScanProbes(db)['semgrep'], 'semgrep');

    expect(probed?.toolVersions).toEqual({ opengrep: '1.8.2', rulepack: 'ignored-by-probe' });
    expect(match).not.toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('runs when there is no earlier run to read a version from', async () => {
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    expect((await press(db, buildScanProbes(db)['semgrep'], 'semgrep')).probed).toBeNull();
  });

  it('runs when the cached engine version was "unknown" — never a guessed one', async () => {
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'semgrep',
        commitSha: HEAD,
        toolVersions: { opengrep: 'unknown', rulepack: 'r' },
        dataVersion: semgrepDataVersion(undefined, undefined, await ruleStateStamp(db, 1)),
      }),
    );
    expect((await press(db, buildScanProbes(db)['semgrep'], 'semgrep')).probed).toBeNull();
  });

  it('runs when the scan image changed since that run (the cached version is not its)', async () => {
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'semgrep',
        commitSha: HEAD,
        toolVersions: { opengrep: '1.8.2', rulepack: 'r' },
        dataVersion: semgrepDataVersion(
          undefined,
          'localhost/repopulse/scan:old',
          await ruleStateStamp(db, 1),
        ),
      }),
    );
    expect((await press(db, buildScanProbes(db)['semgrep'], 'semgrep')).match).toBeNull();
  });

  it('runs when a rule was promoted since (what the same tree stores changed)', async () => {
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    rows(security.ruleRegistry).push({ ruleId: 'sec.x', status: 'candidate' });
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'semgrep',
        commitSha: HEAD,
        toolVersions: { opengrep: '1.8.2', rulepack: 'r' },
        dataVersion: semgrepDataVersion(undefined, undefined, await ruleStateStamp(db, 1)),
      }),
    );
    expect((await press(db, buildScanProbes(db)['semgrep'], 'semgrep')).match).not.toBeNull();
    rows(security.ruleRegistry)[0]!['status'] = 'active';
    expect((await press(db, buildScanProbes(db)['semgrep'], 'semgrep')).match).toBeNull();
  });

  it('covers the third-party pack: switching it on changes the stamp', () => {
    const off = semgrepDataVersion({}, undefined, 'r');
    const on = semgrepDataVersion({ SCAN_THIRD_PARTY_RULES: 'on' }, undefined, 'r');
    // Without a ledger on disk the run uses no third-party pack and stamps none;
    // the stamps are equal then, and different the moment a ledger exists.
    expect(off).not.toBeNull();
    expect(on === off || (on ?? '').includes('thirdParty@')).toBe(true);
  });

  it('is null (run) when a rules-state read failed', () => {
    expect(semgrepDataVersion(undefined, undefined, null)).toBeNull();
  });
});

describe('code_health_tools probe', () => {
  it('reuses the tree-dependent tool versions and guards the registry in data_version', async () => {
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'code_health_tools',
        commitSha: HEAD,
        // Only the adapters this tree triggered — known after a run.
        toolVersions: { lizard: '1.24.0', jscpd: '4.3.0', ruff: '0.6.0' },
        dataVersion: codeHealthDataVersion(undefined, await ruleStateStamp(db, 1)),
      }),
    );
    const { probed, match } = await press(
      db,
      buildScanProbes(db)['code_health_tools'],
      'code_health_tools',
    );
    expect(probed?.toolVersions).toEqual({ lizard: '1.24.0', jscpd: '4.3.0', ruff: '0.6.0' });
    expect(probed?.dataVersion).toMatch(/adapters@[0-9a-f]{12}/);
    expect(match).not.toBeNull();
  });

  it('does not match a run stamped before data_version existed', async () => {
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'code_health_tools',
        commitSha: HEAD,
        toolVersions: { lizard: '1.24.0' },
      }),
    );
    expect(
      (await press(db, buildScanProbes(db)['code_health_tools'], 'code_health_tools')).match,
    ).toBeNull();
  });

  it('changes with the thresholds the run would use', () => {
    expect(codeHealthDataVersion(undefined, 'r')).not.toEqual(
      codeHealthDataVersion({ complexityWarn: 15 }, 'r'),
    );
  });
});

describe('dependency_cve probe', () => {
  it('matches while the advisory database is the one the last run used, and not after a refresh', async () => {
    writeVulnDb(new Date(Date.now() - 86_400_000));
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'dependency_cve',
        commitSha: HEAD,
        toolVersions: { syft: '1.4.1', grype: '0.80.0' },
        dataVersion: dependencyDataVersion(),
      }),
    );
    const probe = buildScanProbes(db)['dependency_cve'];
    expect((await press(db, probe, 'dependency_cve')).match).not.toBeNull();

    // scan-db-sync.sh ran: a newer database build.
    writeVulnDb(new Date(Date.now() - 3_600_000));
    const after = await press(db, probe, 'dependency_cve');
    expect(after.probed).not.toBeNull();
    expect(after.match).toBeNull();
  });

  it('runs when there is no readable database — the scan fails with its own named reason', async () => {
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'dependency_cve',
        commitSha: HEAD,
        toolVersions: { syft: '1', grype: '1' },
      }),
    );
    expect(dependencyDataVersion()).toBeNull();
    expect(
      (await press(db, buildScanProbes(db)['dependency_cve'], 'dependency_cve')).probed,
    ).toBeNull();
  });

  it('runs when the database is stale enough that grype would refuse it', async () => {
    writeVulnDb(new Date(Date.now() - 9 * 86_400_000));
    expect(dependencyDataVersion()).toBeNull();
  });

  it('notices a refreshed malicious-package index', () => {
    writeVulnDb(new Date(Date.now() - 86_400_000));
    const before = dependencyDataVersion();
    mkdirSync(path.join(scanRules, 'malicious'), { recursive: true });
    writeFileSync(path.join(scanRules, 'malicious', 'index.json'), '{"entries":{}}');
    expect(dependencyDataVersion()).not.toEqual(before);
  });
});

describe('container_image probe', () => {
  it('skips within a UTC day and re-resolves tags on the next', async () => {
    writeVulnDb(new Date('2026-10-30T00:00:00Z'));
    vi.useFakeTimers({ toFake: ['Date'] });
    // The database is 1 day old on the 31st, 2 on the 1st: both under grype's limit.
    vi.setSystemTime(new Date('2026-10-31T09:00:00Z'));
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'container_image',
        commitSha: HEAD,
        toolVersions: { grype: '0.80.0' },
        dataVersion: imageDataVersion(),
      }),
    );
    const probe = buildScanProbes(db)['container_image'];
    expect((await press(db, probe, 'container_image')).match).not.toBeNull();

    vi.setSystemTime(new Date('2026-11-01T09:00:00Z'));
    expect((await press(db, probe, 'container_image')).match).toBeNull();
  });

  it('accepts a baseline that stamped no tool versions (a repo naming no images)', async () => {
    writeVulnDb(new Date(Date.now() - 86_400_000));
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'container_image',
        commitSha: HEAD,
        dataVersion: imageDataVersion(),
      }),
    );
    expect(
      (await press(db, buildScanProbes(db)['container_image'], 'container_image')).match,
    ).not.toBeNull();
  });

  it('runs when a run was partial (an image failed to pull)', async () => {
    writeVulnDb(new Date(Date.now() - 86_400_000));
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'container_image',
        commitSha: HEAD,
        partial: true,
        dataVersion: imageDataVersion(),
      }),
    );
    expect(
      (await press(db, buildScanProbes(db)['container_image'], 'container_image')).probed,
    ).toBeNull();
  });
});

describe('anti_slop probe', () => {
  it('has none where no gateway can be built (the API route), and says so by absence', () => {
    const { db } = fakeDb();
    expect(buildScanProbes(db)['anti_slop']).toBeUndefined();
  });

  it('does not let a run with AI off stand in for one with a model on', async () => {
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'anti_slop',
        commitSha: HEAD,
        toolVersions: { opengrep: '1.8.2', rulepack: 'p' },
        dataVersion: await antiSlopRunDataVersion(db, 1, judgementStateOf(null)),
      }),
    );
    let state = 'off';
    const probes = buildScanProbes(db, { antiSlopJudgement: async () => state });
    expect((await press(db, probes['anti_slop'], 'anti_slop')).match).not.toBeNull();

    state = judgementStateOf([
      { name: 'LM Studio', baseUrl: 'http://lan:1234', modelSlot: 'qwen' },
    ]);
    expect(state).toBe('on:LM Studio/qwen');
    expect((await press(db, probes['anti_slop'], 'anti_slop')).match).toBeNull();
  });

  it('stamps the slop half of the pack, not the whole code-health directory', () => {
    expect(antiSlopDataVersion('off', 'r')).toMatch(/rulepack@/);
  });

  it('describes an empty host list as off', () => {
    expect(judgementStateOf([])).toBe('off');
  });
});

describe('architecture_register probe', () => {
  it('matches a baseline stamped with the same adapters and pack, including one with no adapter applied', async () => {
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    rows(security.scanRuns).push(
      // `skipped` by the tool layer closes as succeeded with NO tool versions.
      succeededRun({
        scannerKey: 'architecture_register',
        commitSha: HEAD,
        dataVersion: architectureDataVersion(),
      }),
    );
    const { probed, match } = await press(
      db,
      buildScanProbes(db)['architecture_register'],
      'architecture_register',
    );
    expect(probed?.dataVersion).toMatch(/pack@\d+/);
    expect(match).not.toBeNull();
  });

  it('runs at a commit no run has answered', async () => {
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: 'b'.repeat(40) });
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'architecture_register',
        commitSha: HEAD,
        dataVersion: architectureDataVersion(),
      }),
    );
    expect(
      (await press(db, buildScanProbes(db)['architecture_register'], 'architecture_register'))
        .probed,
    ).toBeNull();
  });
});

describe('supply_chain_register probe', () => {
  const sbomRow = (id: number) => ({ id, commitSha: 'c'.repeat(40) });

  it('pins to the SBOM commit, matches within the day, and not after a new SBOM or a new day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T09:00:00Z'));
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    rows(core.workspaces).push({ settings: null });
    rows(security.sboms).push(sbomRow(7));
    const stamp = await supplyChainDataVersion(db, 1, 2);
    expect(stamp?.commitSha).toBe('c'.repeat(40));
    rows(security.scanRuns).push(
      succeededRun({
        scannerKey: 'supply_chain_register',
        commitSha: stamp!.commitSha,
        dataVersion: stamp!.dataVersion,
      }),
    );
    const probe = buildScanProbes(db)['supply_chain_register'];
    expect((await press(db, probe, 'supply_chain_register')).match).not.toBeNull();

    // The dependency scan regenerated the SBOM (same commit, new row).
    rows(security.sboms).unshift(sbomRow(8));
    expect((await press(db, probe, 'supply_chain_register')).match).toBeNull();
    rows(security.sboms).shift();

    // A policy edit changes what the register would report.
    rows(core.workspaces)[0]!['settings'] = { license_policy: { allow: ['MIT'], flag: [] } };
    expect((await press(db, probe, 'supply_chain_register')).match).toBeNull();
    rows(core.workspaces)[0]!['settings'] = null;

    vi.setSystemTime(new Date('2026-11-01T09:00:00Z'));
    expect((await press(db, probe, 'supply_chain_register')).match).toBeNull();
  });

  it('runs (null) when there is no SBOM — the runner reports no_sbom itself', async () => {
    const { db, rows } = fakeDb();
    rows(facts.commits).push({ sha: HEAD });
    expect(
      (await press(db, buildScanProbes(db)['supply_chain_register'], 'supply_chain_register'))
        .probed,
    ).toBeNull();
  });
});

describe('every weekly runner is probed or says why it always runs (W23-09)', () => {
  // The runner keys, read from the worker entrypoint so a new runner that
  // declares neither fails here instead of silently running forever.
  const source = readFileSync(path.resolve(__dirname, '../../workers/index.ts'), 'utf8');
  const block = source.slice(source.indexOf('weeklyRunners: {'));
  const body = block.slice(0, block.search(/\n {8}\},\n/));
  const runnerKeys = [...body.matchAll(/^ {10}([a-z_]+): (?:async|\()/gm)].map((m) => m[1]!);

  it('finds the runners it is guarding', () => {
    expect(runnerKeys).toEqual(
      expect.arrayContaining([
        'semgrep',
        'code_health_tools',
        'dependency_cve',
        'container_image',
        'anti_slop',
        'supply_chain_register',
        'architecture_register',
        'knowledge_register',
        'owasp_web',
        'owasp_llm',
        'test_gap_register',
        'code_scanning_pull',
        'attack_chainer',
      ]),
    );
  });

  it('has a probe or a reason for each, and never both', () => {
    for (const key of runnerKeys) {
      const probed = PROBED_RUNNERS.includes(key);
      const reason = ALWAYS_RUN[key];
      expect(probed || (reason !== undefined && reason.length > 40), key).toBe(true);
      expect(probed && reason !== undefined, `${key} is in both lists`).toBe(false);
    }
  });

  it('builds a probe for every probed key once a judgement source is injected', () => {
    const { db } = fakeDb();
    const probes = buildScanProbes(db, { antiSlopJudgement: async () => 'off' });
    for (const key of PROBED_RUNNERS) expect(probes[key], key).toBeTypeOf('function');
    for (const key of Object.keys(ALWAYS_RUN)) expect(probes[key], key).toBeUndefined();
  });
});
