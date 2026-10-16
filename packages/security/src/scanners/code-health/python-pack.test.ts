import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Python packs (W18-11): anti-slop, logging, perf and the security
// baseline, each a sibling of its JavaScript pack in its own file.
//
// The golden tests beside the JavaScript packs need the scan image (podman),
// which most machines that run this suite do not have — and a pack whose only
// proof is a skipped test is a pack nobody has proven. So these run the rules
// with whichever semgrep-compatible engine is on PATH, and skip only when
// there is none. Opengrep, which production runs, reads the same rule format.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const rel = (...p: string[]) => path.join(ROOT, ...p);

interface Pack {
  file: string;
  triggering: string;
  clean: string;
  prefix: RegExp;
  ids: string[];
}

const PACKS: Pack[] = [
  {
    file: rel('rulepacks/code-health/anti-slop.python.v1.yaml'),
    triggering: rel('fixtures/code-health/triggering/slop.py'),
    clean: rel('fixtures/code-health/clean/tidy.py'),
    prefix: /^bpm-ch-[a-z-]+-py$/,
    ids: [
      'bpm-ch-bare-except-py',
      'bpm-ch-emoji-comment-py',
      'bpm-ch-empty-except-py',
      'bpm-ch-prose-padding-py',
      'bpm-ch-silent-fallback-return-py',
      'bpm-ch-step-narration-py',
      'bpm-ch-stub-as-feature-py',
      'bpm-ch-try-except-in-loop-py',
      'bpm-ch-what-comment-py',
    ],
  },
  {
    file: rel('rulepacks/code-health/logging.python.v1.yaml'),
    triggering: rel('fixtures/code-health/triggering/logging.py'),
    clean: rel('fixtures/code-health/clean/logging_tidy.py'),
    // The logging scanner keeps only bpm-log-* ids; anything else is dropped.
    prefix: /^bpm-log-[a-z-]+-py$/,
    ids: [
      'bpm-log-and-reraise-py',
      'bpm-log-injection-py',
      'bpm-log-print-in-prod-py',
      'bpm-log-secret-field-py',
    ],
  },
  {
    file: rel('rulepacks/code-health/perf/perf.python.v1.yaml'),
    triggering: rel('fixtures/perf/triggering/async_app.py'),
    clean: rel('fixtures/perf/clean/async_app.py'),
    prefix: /^bpm-perf-[a-z-]+-py$/,
    ids: [
      'bpm-perf-await-in-loop-py',
      'bpm-perf-blocking-call-in-async-py',
      'bpm-perf-json-deep-clone-py',
      'bpm-perf-regex-compile-in-loop-py',
      'bpm-perf-string-concat-in-loop-py',
      'bpm-perf-unbounded-gather-py',
    ],
  },
  {
    file: rel('rulepacks/semgrep/bpm-baseline.python.v1.yaml'),
    triggering: rel('fixtures/semgrep/vulnerable/app.py'),
    clean: rel('fixtures/semgrep/safe/app.py'),
    prefix: /^bpm-py-[a-z-]+$/,
    ids: [
      'bpm-py-eval-dynamic',
      'bpm-py-jwt-verify-disabled',
      'bpm-py-random-token',
      'bpm-py-sql-string-build',
      'bpm-py-subprocess-shell-concat',
      'bpm-py-weak-hash',
    ],
  },
];

const idsIn = (text: string): string[] =>
  [...text.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1] as string);

describe('the Python packs are ours, and ship in shadow', () => {
  for (const pack of PACKS) {
    const text = readFileSync(pack.file, 'utf8');
    const name = path.basename(pack.file);

    it(`${name}: our ids, one provenance and one candidate lifecycle per rule`, () => {
      const ids = idsIn(text);
      expect(ids.sort()).toEqual(pack.ids);
      for (const id of ids) expect(id, id).toMatch(pack.prefix);
      expect((text.match(/provenance: written for RepoPulse/g) ?? []).length).toBe(ids.length);
      // New rules start as candidates (§8): their findings run in shadow until
      // an admin promotes them on evidence.
      expect((text.match(/lifecycle: candidate/g) ?? []).length).toBe(ids.length);
      for (const marker of ['python.lang.security', 'semgrep.dev', 'p/ci', '--config auto']) {
        expect(text, marker).not.toContain(marker);
      }
    });

    it(`${name}: every rule is Python-only`, () => {
      const languages = [...text.matchAll(/^\s*languages:\s*(.+)$/gm)].map((m) => m[1]?.trim());
      expect(languages.length).toBe(pack.ids.length);
      for (const l of languages) expect(l).toBe('[python]');
    });
  }

  it('code-health and perf rules stay at or below WARNING', () => {
    for (const pack of PACKS.slice(0, 3)) {
      const text = readFileSync(pack.file, 'utf8');
      expect(text, pack.file).not.toContain('severity: ERROR');
    }
  });
});

// Without these the engine checks the network for a newer version first, and
// on a sandboxed machine that stalls each call for its full timeout.
const ENGINE_ENV = {
  ...process.env,
  SEMGREP_ENABLE_VERSION_CHECK: '0',
  SEMGREP_SEND_METRICS: 'off',
  // The packs contain non-ASCII; the engine's Python layer crashes under a C locale.
  PYTHONUTF8: '1',
  LC_ALL: 'en_US.UTF-8',
};

const engine = (() => {
  for (const bin of ['opengrep', 'semgrep']) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe', timeout: 30_000, env: ENGINE_ENV });
      return bin;
    } catch {
      // not installed; try the next one
    }
  }
  return undefined;
})();

const describeIfEngine = engine ? describe : describe.skip;

interface EngineResult {
  results: { check_id: string; start: { line: number } }[];
  errors: unknown[];
}

function scan(config: string, target: string): EngineResult {
  const stdout = execFileSync(
    engine!,
    [...(engine === 'semgrep' ? ['--metrics=off'] : []), '--json', '--config', config, target],
    {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
      env: ENGINE_ENV,
    },
  ).toString();
  return JSON.parse(stdout) as EngineResult;
}

const bare = (checkId: string): string => checkId.split('.').pop() ?? checkId;

describeIfEngine('the Python packs, run by the engine', () => {
  for (const pack of PACKS) {
    const name = path.basename(pack.file);

    it(`${name}: every rule fires on the triggering fixture, with no rule errors`, () => {
      const out = scan(pack.file, pack.triggering);
      // A rule that fails to parse takes itself out silently; zero errors is
      // what proves every rule was actually evaluated.
      expect(out.errors).toEqual([]);
      expect([...new Set(out.results.map((r) => bare(r.check_id)))].sort()).toEqual(pack.ids);
    }, 180_000);

    it(`${name}: NOTHING fires on the clean fixture`, () => {
      const out = scan(pack.file, pack.clean);
      expect(out.errors).toEqual([]);
      expect(out.results.map((r) => `${bare(r.check_id)}:${r.start.line}`)).toEqual([]);
    }, 180_000);
  }
});
