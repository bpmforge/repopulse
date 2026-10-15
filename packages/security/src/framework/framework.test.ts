import { afterEach, describe, expect, it } from 'vitest';
import { BudgetExceededError, BudgetMeter, DEFAULT_BUDGET, runScanner } from './budget.js';
import {
  getScanner,
  listScanners,
  registerScanner,
  requiredTools,
  resetRegistry,
  scannersForTrigger,
} from '../registry.js';
import { SCANNER_DEFAULTS, isEnabled } from '../config/defaults.js';
import type { Scanner, ScannerContext } from './types.js';

// Scanner framework (W8-01, SECURITY_SUITE.md §1, FR-SEC-1 / NFR-15).

const ctx = (over: Partial<ScannerContext> = {}): ScannerContext =>
  ({
    repoId: '1',
    workspaceId: '1',
    commitSha: 'abc',
    trigger: 'pr_synced',
    budget: DEFAULT_BUDGET,
    signal: new AbortController().signal,
    log: { info: () => undefined },
    diff: () => (async function* () {})(),
    getFileContent: async () => ({ path: 'a', content: '' }),
    snapshot: async () => {
      throw new Error('not a snapshot scanner');
    },
    priorFindings: async () => [],
    gateway: {} as ScannerContext['gateway'],
    ...over,
  }) as ScannerContext;

const scanner = (over: Partial<Scanner> = {}): Scanner => ({
  key: 'fixture',
  displayName: 'Fixture scanner',
  version: '1.0.0',
  inputs: 'diff',
  triggers: ['pr_synced'],
  run: async () => [],
  ...over,
});

afterEach(() => resetRegistry());

describe('registry (FR-SEC-1)', () => {
  it('adding a scanner is one registry line — dispatch reads metadata only', () => {
    // The extensibility claim. If this ever needed a framework change, the
    // claim would already be false.
    registerScanner(scanner({ key: 'backlog', triggers: ['schedule'] }));
    expect(getScanner('backlog')?.displayName).toBe('Fixture scanner');
    expect(scannersForTrigger('schedule').map((s) => s.key)).toEqual(['backlog']);
    expect(scannersForTrigger('pr_synced')).toEqual([]);
  });

  it('THROWS on a duplicate key rather than overwriting', () => {
    // The widget registry overwrote silently and cost a panel in W5-07. Here a
    // duplicate would misattribute findings to the wrong tool — the key is
    // stamped on every finding — so it fails loudly at startup instead.
    registerScanner(scanner({ key: 'secrets' }));
    expect(() => registerScanner(scanner({ key: 'secrets', displayName: 'Other' }))).toThrow(
      /already registered/,
    );
  });

  it('re-registering the SAME object is a no-op, so module reloads are safe', () => {
    const s = scanner();
    registerScanner(s);
    expect(() => registerScanner(s)).not.toThrow();
    expect(listScanners()).toHaveLength(1);
  });

  it('reports the tools a scanner set needs, deduped', () => {
    registerScanner(scanner({ key: 'a', requiredTools: ['semgrep@1'] }));
    registerScanner(scanner({ key: 'b', requiredTools: ['semgrep@1', 'syft@1'] }));
    expect(requiredTools(listScanners())).toEqual(['semgrep@1', 'syft@1']);
  });

  it('a pure-TypeScript scanner declares no tools', () => {
    registerScanner(scanner());
    expect(requiredTools(listScanners())).toEqual([]);
  });
});

describe('failure isolation (NFR-15)', () => {
  it('a CRASHING scanner returns a failed result rather than throwing', async () => {
    // The whole point: a scanner is third-party code, and the worst it may do
    // is produce no findings. If this rethrew, one poison scanner would take
    // ingestion and every other scanner down with it.
    const result = await runScanner(
      scanner({
        run: async () => {
          throw new Error('boom');
        },
      }),
      ctx(),
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom');
    expect(result.findings).toEqual([]);
  });

  it('a scanner that exceeds wall-clock is budget_exceeded, not failed', async () => {
    // A distinct status because they need distinct responses: failed is a bug
    // to fix, budget_exceeded is a limit to raise or a repo too big for it.
    const result = await runScanner(
      scanner({ run: () => new Promise(() => undefined) }),
      ctx({ budget: { ...DEFAULT_BUDGET, wallClockMs: 20 } }),
    );
    expect(result.status).toBe('budget_exceeded');
    expect(result.partial).toBe(true);
  });

  it('records duration even when the scanner fails', async () => {
    const result = await runScanner(
      scanner({
        run: async () => {
          throw new Error('x');
        },
      }),
      ctx(),
    );
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('budget meter (§1.2)', () => {
  it('stops a scanner spending past its forge quota', () => {
    const meter = new BudgetMeter({ ...DEFAULT_BUDGET, forgeCalls: 2 });
    meter.chargeForgeCall();
    meter.chargeForgeCall();
    // Enforced by the framework, not trusted to the scanner: a runaway scanner
    // would otherwise spend the whole workspace's forge budget (Law 7).
    expect(() => meter.chargeForgeCall()).toThrow(BudgetExceededError);
  });

  it('stops a checklist scanner spending past its token budget', () => {
    const meter = new BudgetMeter({ ...DEFAULT_BUDGET, llmTokens: 100 });
    meter.chargeTokens(60);
    expect(() => meter.chargeTokens(60)).toThrow(/llmTokens/);
  });

  it('reports what was spent, so a budget_exceeded run can be explained', () => {
    const meter = new BudgetMeter(DEFAULT_BUDGET);
    meter.chargeForgeCall();
    meter.chargeTokens(10);
    expect(meter.spent()).toEqual({ forgeCalls: 1, llmTokens: 10 });
  });
});

describe('enablement defaults (FR-SEC-11)', () => {
  it('has the documented workspace posture', () => {
    // Grew in W16-28. Nine of these had had a weekly or nightly runner wired
    // since W9/W10 with no entry here, so the admin screen listed neither a
    // default nor a rationale for work that was already happening — and
    // `dependency` governed a key nothing used, the scanner stamping every
    // finding it makes `dependency_cve`.
    const on = SCANNER_DEFAULTS.filter((d) => d.enabled).map((d) => d.key);
    expect(on).toEqual([
      'secrets',
      // W16-36: back on, now that the worker actually calls runDependencyScan.
      'dependency_cve',
      'semgrep',
      'attack_chainer',
      'code_health_tools',
      'anti_slop',
      'logging_hygiene',
      'performance',
      // W18-21: rides the secrets stream's diff, so it costs one regex pass.
      'sensitive_change',
      'supply_chain_register',
      'architecture_register',
      'test_gap_register',
      'knowledge_register',
      'rule_draft_pass',
    ]);
    expect(on).not.toContain('dependency');
  });

  it('every default explains itself', () => {
    // The defaults ARE a security posture — what is on without anyone deciding
    // is what most workspaces get — so each one carries its reason into the UI.
    for (const d of SCANNER_DEFAULTS) expect(d.rationale.length).toBeGreaterThan(30);
  });

  it('an explicit stored FALSE beats a default of true', () => {
    // `stored?.enabled ?? default` would be right here by luck and wrong the
    // moment a default flips — a repo that opted out would silently opt back in.
    expect(isEnabled('secrets', { enabled: false })).toBe(false);
    expect(isEnabled('secrets', undefined)).toBe(true);
  });

  it('an unknown scanner key is disabled, not enabled', () => {
    // Fail closed: a key with no default is one nobody has reasoned about.
    expect(isEnabled('mystery', undefined)).toBe(false);
  });
});
