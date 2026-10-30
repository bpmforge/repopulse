import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUILTIN_SCANNERS, registerBuiltinScanners } from './catalogue.js';
import { getScanner, listScanners, resetRegistry, scannersForTrigger } from './registry.js';
import { SCANNER_DEFAULTS, isEnabled } from './config/defaults.js';

// W16-28. The registry had no production caller for eight waves.
//
// registerScanner() was reachable only from registry.ts and framework.test.ts,
// so listScanners() returned [] in every process: every scanner read
// "(not installed)" on the Scanners screen, getScanner() was always undefined,
// and every scan_run recorded scannerVersion "unregistered". These tests are
// the thing that would have caught it — they assert the catalogue is non-empty
// in a process that only imported it.

describe('the built-in catalogue', () => {
  beforeEach(() => {
    resetRegistry();
  });

  it('is not empty, which is the whole bug', () => {
    expect(listScanners()).toHaveLength(0);
    registerBuiltinScanners();
    expect(listScanners().length).toBe(BUILTIN_SCANNERS.length);
    expect(listScanners().length).toBeGreaterThan(5);
  });

  it('can be registered twice, because both entrypoints call it', () => {
    registerBuiltinScanners();
    expect(() => registerBuiltinScanners()).not.toThrow();
    expect(listScanners().length).toBe(BUILTIN_SCANNERS.length);
  });

  it('gives every scanner a version, so no run records "unregistered"', () => {
    registerBuiltinScanners();
    for (const scanner of listScanners()) {
      expect(scanner.version, scanner.key).toMatch(/^[a-z_]+\.v\d+$/);
      expect(scanner.displayName, scanner.key).not.toBe('');
    }
    expect(getScanner('secrets')?.version).toBe('secrets.v1');
  });

  it('has no duplicate keys — a duplicate misattributes findings', () => {
    const keys = BUILTIN_SCANNERS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('what the catalogue claims can be started', () => {
  beforeEach(() => {
    resetRegistry();
    registerBuiltinScanners();
  });

  // The constraint that keeps this from inverting W16-20: a scanner declares
  // `manual` only when the worker has a runner for it. The manual-run route
  // enqueues nothing else, so the started-count never counts a job that can
  // only reach "no history runner is wired".
  const WIRED_IN_THE_WORKER = [
    'secrets',
    'semgrep',
    'code_health_tools',
    'anti_slop',
    'attack_chainer',
    'supply_chain_register',
    'architecture_register',
    'test_gap_register',
    'knowledge_register',
    // rule_draft_pass is wired but schedule-only since 2026-10-30: started by
    // "Run scan" it took the one model slot from anti-slop.
    // W16-36 wired runDependencyScan, which had no caller for eight waves.
    'dependency_cve',
    // W16-33 wired runOwaspChecklist, which had none either. Manual only —
    // they are not in the weekly cron group.
    'owasp_web',
    'owasp_llm',
    // W18-24: the code-scanning alert import, nightly and by hand.
    'code_scanning_pull',
    // W18-34: container images, opt-in and started by hand.
    'container_image',
  ];

  it('offers manual runs for exactly the keys the worker wires', () => {
    const manual = scannersForTrigger('manual').map((s) => s.key);
    expect([...manual].sort()).toEqual([...WIRED_IN_THE_WORKER].sort());
  });

  it('lists the two scanners that exist but nothing can start', () => {
    // logging_hygiene and performance run inside the anti_slop runner, on the
    // snapshot it already paid for, so they have no runner of their own. They
    // are catalogued so the screen stops claiming they are absent, and not
    // offered, because today no button reaches them. dependency_cve WAS the
    // third until W16-36 gave it a caller.
    for (const key of ['logging_hygiene', 'performance']) {
      expect(getScanner(key), key).toBeDefined();
      expect(getScanner(key)?.triggers, key).not.toContain('manual');
    }
  });

  it('refuses a per-SHA run rather than reporting a clean repository', async () => {
    // A stub returning [] would say "no findings", which is what a clean repo
    // looks like. Nothing enqueues sha-mode, so this is unreachable — and it
    // must stay loud if anything ever does.
    await expect(getScanner('semgrep')!.run({} as never)).rejects.toThrow(/sweep scanner/i);
  });
});

describe('defaults line up with the catalogue (W16-28)', () => {
  beforeEach(() => {
    resetRegistry();
    registerBuiltinScanners();
  });

  it('every enabled-by-default scanner is one that exists', () => {
    // The bug this catches: SCANNER_DEFAULTS said `dependency` while the
    // scanner stamps `dependency_cve`, so the default governed a key nothing
    // used and the real scanner had no default at all.
    for (const def of SCANNER_DEFAULTS.filter((d) => d.enabled)) {
      expect(getScanner(def.key), `${def.key} is enabled by default`).toBeDefined();
    }
  });

  // Scanners whose runner is the secrets stream itself (W18-21): they read the
  // diff that scan already fetched, on pr_synced/push, and have no manual or
  // scheduled runner of their own. Listed here, and each one proven to be
  // CALLED by the stream below, so "rides the stream" cannot become the new
  // way to be enabled and unreachable.
  const STREAM_RIDERS: Record<string, string> = {
    sensitive_change: 'runSensitiveChangeScan(',
    // W21-05: diff mode rides the stream; snapshot mode runs inside the
    // weekly dependency scan (its `schedule` trigger).
    slopsquat: 'runSlopsquatDiffScan(',
  };

  it('no scanner is enabled by default that no runner can reach', () => {
    for (const def of SCANNER_DEFAULTS.filter((d) => d.enabled)) {
      const scanner = getScanner(def.key)!;
      const reachable =
        scanner.triggers.includes('manual') ||
        scanner.triggers.includes('schedule') ||
        (def.key in STREAM_RIDERS && scanner.triggers.includes('pr_synced'));
      expect(reachable, def.key).toBe(true);
    }
  });

  it('every stream rider is actually called by the secrets stream', () => {
    const stream = readFileSync(
      fileURLToPath(new URL('./scanners/secrets/stream.ts', import.meta.url)),
      'utf8',
    );
    for (const call of Object.values(STREAM_RIDERS)) expect(stream).toContain(`await ${call}`);
  });

  it('enables dependency_cve now that something calls runDependencyScan (W16-36)', () => {
    // It was deliberately off while the scanner had no caller — an enabled
    // scanner that cannot run is a presence that reads as a capability.
    expect(isEnabled('dependency_cve', undefined)).toBe(true);
    // And the key it was misfiled under is gone, rather than left as a second
    // row that would resolve to a scanner that does not exist.
    expect(SCANNER_DEFAULTS.some((d) => d.key === 'dependency')).toBe(false);
  });
});
