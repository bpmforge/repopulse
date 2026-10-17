import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CORPUS_DIR } from './corpus.js';
import type { AdapterRun } from './engines.js';
import { adapterGate, renderMarkdown } from './report.js';
import { runBenchmark } from './run.js';

// The tool-adapter lane (W18-48): checkov, actionlint, hadolint and shellcheck
// scored per rule on our own labelled fixtures. These tests need no scan image;
// the lane that really runs the tools is exercised by `pnpm bench`.

const SUITE = path.join(CORPUS_DIR, 'iac-adapters');
const manifest = JSON.parse(readFileSync(path.join(SUITE, 'suite.json'), 'utf8')) as {
  lane: string;
  unlabelled: string;
  labels: {
    id: string;
    tree: string;
    file: string;
    lines: [number, number];
    rule: string;
    dimension: string;
    expect: string;
  }[];
};

function walk(dir: string, rel = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    return statSync(full).isDirectory() ? walk(full, r) : [r];
  });
}

/** `# expect: <rules>` markers: on the line above the defect, or trailing on it. */
function markers(tree: string): { file: string; line: number; rule: string }[] {
  const root = path.join(SUITE, tree);
  const out: { file: string; line: number; rule: string }[] = [];
  for (const file of walk(root)) {
    const lines = readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((text, i) => {
      const own = /^\s*#\s*expect:\s*(.+)$/.exec(text);
      const trailing = /\S\s+#\s*expect:\s*(.+)$/.exec(text);
      const m = own ?? trailing;
      if (!m) return;
      let target = i;
      if (own) {
        target = i + 1;
        while (target < lines.length && (/^\s*#/.test(lines[target]!) || !lines[target]!.trim())) {
          target++;
        }
      }
      for (const rule of m[1]!.trim().split(/\s+/)) out.push({ file, line: target + 1, rule });
    });
  }
  return out;
}

describe('the iac-adapters suite', () => {
  it('is read by the adapters lane alone, and scores unlabelled findings as false positives', () => {
    expect(manifest.lane).toBe('adapters');
    expect(manifest.unlabelled).toBe('fp');
  });

  it('labels only tool rules of the four adapters, on the triggering tree', () => {
    for (const l of manifest.labels) {
      expect(l.rule, l.id).toMatch(/^tool\.(checkov|actionlint|hadolint|shellcheck)\./);
      expect(l.tree, l.id).toBe('triggering');
      expect(l.expect, l.id).toBe('finding');
    }
  });

  it('has a label for every expect marker in the fixtures, and a marker for every label', () => {
    const fromMarkers = markers('triggering');
    for (const m of fromMarkers) {
      const hit = manifest.labels.find(
        (l) =>
          l.file === m.file &&
          l.rule === `tool.${m.rule.replace(/^tool\./, '')}` &&
          l.lines[0] <= m.line &&
          m.line <= l.lines[1],
      );
      expect(hit, `${m.file}:${m.line} ${m.rule} has no label`).toBeDefined();
    }
    expect(manifest.labels.length).toBe(fromMarkers.length);
  });

  it('keeps the clean tree free of expectations', () => {
    expect(markers('clean')).toEqual([]);
  });
});

/** A corpus holding only the adapters suite, so these tests do not replay every other suite. */
function onlyAdaptersCorpus(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'w18-48-corpus-'));
  cpSync(SUITE, path.join(root, 'iac-adapters'), { recursive: true });
  return root;
}

describe('scoring the adapters lane', () => {
  const corpusDir = onlyAdaptersCorpus();

  it('without the scan image, skips the labels and says the lane did not run', () => {
    const r = runBenchmark({
      corpusDir,
      yaml: false,
      adaptersReason: 'no scan image',
    });
    expect(r.engines.adapters).toEqual({ status: 'unavailable', reason: 'no scan image' });
    expect(r.outcomes.filter((o) => o.kind === 'skipped')).toHaveLength(manifest.labels.length);
    expect(r.outcomes.some((o) => o.kind === 'fn')).toBe(false);
    expect(r.byRule.some((x) => x.engine === 'adapter')).toBe(false);
    expect(renderMarkdown(r)).toContain('Tool adapters: not run (no scan image)');
  });

  it('scores a finding on a label as a true positive, a stray one as a false positive, an unseen label as a miss', () => {
    const [first, second] = manifest.labels;
    const run: AdapterRun = {
      tools: { hadolint: '2.15.1' },
      trees: 2,
      findings: [
        {
          suite: 'iac-adapters',
          tree: 'triggering',
          file: first!.file,
          lineStart: first!.lines[0],
          lineEnd: first!.lines[0],
          ruleId: first!.rule,
          dimension: first!.dimension,
          cwe: null,
        },
        {
          suite: 'iac-adapters',
          tree: 'clean',
          file: 'docker/Dockerfile.node',
          lineStart: 1,
          lineEnd: 1,
          ruleId: 'tool.hadolint.DL9999',
          dimension: 'correctness',
          cwe: null,
        },
      ],
    };
    const r = runBenchmark({ corpusDir, yaml: false, adapters: run });
    const rule = (id: string) => r.byRule.find((x) => x.rule === id)!;
    expect(rule(first!.rule).score.tp).toBe(1);
    expect(rule('tool.hadolint.DL9999').score.fp).toBe(1);
    expect(rule(second!.rule).score.fn).toBeGreaterThanOrEqual(1);
    expect(rule(first!.rule).engine).toBe('adapter');
    expect(r.engines.adapters).toEqual({ status: 'ran', tools: { hadolint: '2.15.1' }, trees: 2 });
    const md = renderMarkdown(r);
    expect(md).toContain('## Tool adapters: precision and the promotion gate');
    expect(md).toContain('**no rule below is promoted**');
    expect(md).toContain('not yet run');
  });

  it('refuses a label that names something other than a tool rule', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'w18-48-bad-'));
    cpSync(SUITE, path.join(root, 'iac-adapters'), { recursive: true });
    const file = path.join(root, 'iac-adapters', 'suite.json');
    const bad = JSON.parse(readFileSync(file, 'utf8')) as typeof manifest;
    bad.labels[0]!.rule = 'bpm-not-a-tool-rule';
    writeFileSync(file, JSON.stringify(bad));
    expect(() => runBenchmark({ corpusDir: root, yaml: false })).toThrow(/not a tool\.\* rule/);
  });
});

describe('the benchmark half of the promotion gate', () => {
  const score = (tp: number, fp: number) => ({
    tp,
    fp,
    fn: 0,
    tn: 0,
    duplicate: 0,
    ignored: 0,
    skipped: 0,
    precision: null,
    recall: null,
  });

  it('is not met by a handful of cases, however clean', () => {
    expect(adapterGate(score(3, 0))).toEqual({ met: false, text: '3/20 findings' });
  });

  it('names a false-positive rate over the limit', () => {
    expect(adapterGate(score(10, 10)).text).toBe('50% false positives (limit 20%)');
  });

  it('is met with enough labelled findings and few enough false positives', () => {
    expect(adapterGate(score(20, 2))).toEqual({ met: true, text: 'benchmark half met' });
  });
});

describe('runAdapterLane', () => {
  it('keeps only the four adapters, and refuses a run where a tool or the scan failed', async () => {
    vi.resetModules();
    const calls: unknown[] = [];
    vi.doMock('../scanners/code-health/tools.js', () => ({
      runCodeHealthTools: async (args: { targetDir: string }) => {
        calls.push(args.targetDir);
        if (args.targetDir.endsWith('boom')) {
          return {
            status: 'failed',
            error: 'exit 125',
            adapterFindings: [],
            adapterErrors: [],
            toolVersions: {},
          };
        }
        if (args.targetDir.endsWith('crash')) {
          return {
            status: 'succeeded',
            adapterFindings: [],
            adapterErrors: [{ adapter: 'checkov', reason: 'timed out' }],
            toolVersions: {},
          };
        }
        return {
          status: 'succeeded',
          adapterErrors: [],
          toolVersions: { checkov: '3.3.29', ruff: '0.16.3' },
          adapterFindings: [
            {
              ruleId: 'tool.checkov.CKV_AWS_24',
              file: 'a.tf',
              lineStart: 2,
              lineEnd: 9,
              dimension: 'iac',
            },
            {
              ruleId: 'tool.ruff.E722',
              file: 'a.py',
              lineStart: 1,
              lineEnd: 1,
              dimension: 'code_health',
            },
          ],
        };
      },
    }));
    const { runAdapterLane } = await import('./engines.js');
    const tree = (name: string) => ({ suite: 's', id: name, dir: `/x/${name}` });
    const run = await runAdapterLane([tree('ok')], { image: 'img' });
    expect(run.findings.map((f) => f.ruleId)).toEqual(['tool.checkov.CKV_AWS_24']);
    expect(run.tools).toEqual({ checkov: '3.3.29' });
    await expect(runAdapterLane([tree('boom')], { image: 'img' })).rejects.toThrow(/did not scan/);
    await expect(runAdapterLane([tree('crash')], { image: 'img' })).rejects.toThrow(/timed out/);
    vi.doUnmock('../scanners/code-health/tools.js');
  });
});
