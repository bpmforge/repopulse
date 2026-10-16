import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addedLines } from '../scanners/secrets/detect.js';
import { CORPUS_DIR, loadCorpus, treeFiles } from './corpus.js';
import { fastLaneRules, findYamlTool, runFastLane, wholeFilePatch, yamlPacks } from './engines.js';
import { parseAnswerKey, selectTests } from './prepare-owasp.js';
import { runBenchmark } from './run.js';

// The committed corpus and answer key (W18-17). A broken label scores as a
// miss and quietly lowers a published recall, so the key is checked here on
// every test run, without needing an engine.

const suites = loadCorpus();

describe('benchmark corpus', () => {
  it('has the four committed suites and the two fetched public ones', () => {
    expect(suites.map((s) => s.manifest.id)).toEqual([
      'changes',
      'juice-shop',
      'juliet-java',
      'owasp-benchmark',
      'rule-fixtures',
      'sampleco',
    ]);
  });

  it('ships the upstream licence next to every vendored suite', () => {
    for (const s of suites.filter((x) => x.manifest.source.kind === 'vendored')) {
      expect(existsSync(path.join(s.dir, 'LICENSE')), s.manifest.id).toBe(true);
      expect(s.manifest.source.commit, s.manifest.id).toMatch(/^[0-9a-f]{40}$/);
      expect(readFileSync(path.join(s.dir, 'LICENSE'), 'utf8')).toMatch(
        /MIT License|Permission is hereby granted/,
      );
    }
  });

  it('labels only files that exist, within their line counts, with rules that exist', () => {
    const known = new Set([...fastLaneRules().keys(), ...yamlPacks().rules.keys()]);
    for (const s of suites.filter((x) => x.prepared)) {
      for (const l of s.labels) {
        const tree = s.trees.find((t) => t.id === l.tree)!;
        const file = path.join(tree.dir, l.file);
        expect(existsSync(file), `${s.manifest.id}/${l.id}`).toBe(true);
        if (l.lines) {
          const lines = readFileSync(file, 'utf8').split('\n').length;
          expect(l.lines[1], `${s.manifest.id}/${l.id}`).toBeLessThanOrEqual(lines);
        }
        for (const r of [l.rule, ...(l.accept ?? [])].filter((x) => x !== undefined)) {
          expect(known.has(r), `${s.manifest.id}/${l.id}: ${r}`).toBe(true);
        }
      }
    }
  });

  it('pairs every bug-introducing change with its before tree, and labels only the after side of the change', () => {
    const changes = suites.find((s) => s.manifest.id === 'changes')!;
    const cases = new Set(changes.trees.map((t) => t.id.split('/')[0]));
    for (const c of cases) {
      expect(changes.trees.map((t) => t.id)).toEqual(
        expect.arrayContaining([`${c}/before`, `${c}/after`]),
      );
      expect(
        changes.labels.some((l) => l.tree === `${c}/after`),
        c,
      ).toBe(true);
    }
  });

  it('commits no OWASP Benchmark source: only ids and hashes, fetched into a gitignored cache', () => {
    const owasp = suites.find((s) => s.manifest.id === 'owasp-benchmark')!;
    const spec = owasp.manifest.fetch!;
    expect(spec.files.length).toBeGreaterThanOrEqual(60);
    expect(spec.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(owasp.manifest.labels).toEqual([]);
    expect(treeFiles(owasp.dir)).toEqual(['suite.json']);
    expect(readFileSync(path.join(CORPUS_DIR, '.gitignore'), 'utf8')).toContain('.cache/');
  });
});

describe('OWASP answer key helpers', () => {
  const csv = [
    '# test name, category, real vulnerability, cwe',
    'BenchmarkTest00001,sqli,true,89',
    'BenchmarkTest00002,sqli,false,89',
    'BenchmarkTest00003,cmdi,true,78',
    'BenchmarkTest00004,sqli,true,89',
    '',
  ].join('\n');

  it('parses the expectedresults CSV and skips its comment header', () => {
    expect(parseAnswerKey(csv)).toEqual([
      { test: 'BenchmarkTest00001', category: 'sqli', real: true, cwe: 89 },
      { test: 'BenchmarkTest00002', category: 'sqli', real: false, cwe: 89 },
      { test: 'BenchmarkTest00003', category: 'cmdi', real: true, cwe: 78 },
      { test: 'BenchmarkTest00004', category: 'sqli', real: true, cwe: 89 },
    ]);
  });

  it('selects the first N real and N false cases per category, in key order', () => {
    const picked = selectTests(parseAnswerKey(csv), { categories: ['sqli'], perVerdict: 1 });
    expect(picked.map((r) => r.test)).toEqual(['BenchmarkTest00001', 'BenchmarkTest00002']);
  });
});

describe('fast lane engine', () => {
  it('numbers whole-file patch lines the way the secrets scanner reads a diff', () => {
    const lines = addedLines(wholeFilePatch('a\nb\nc\n'));
    expect(lines).toEqual([
      { line: 1, text: 'a' },
      { line: 2, text: 'b' },
      { line: 3, text: 'c' },
    ]);
  });

  it('finds the phantom, unused-export and docstring cases on the after side and nothing on the before side', () => {
    const changes = suites.find((s) => s.manifest.id === 'changes')!;
    const tree = (id: string) => changes.trees.find((t) => t.id === id)!;
    const rules = (id: string) =>
      runFastLane(tree(id)).map((f) => `${f.ruleId}:${f.file}:${f.lineStart}`);
    expect(rules('slop-phantom-symbol/after')).toEqual(['slop.phantom_symbol:src/invoice.ts:1']);
    expect(rules('slop-phantom-symbol/before')).toEqual([]);
    expect(rules('slop-phantom-module/after')).toEqual(['slop.phantom_module:src/rates.ts:2']);
    expect(rules('slop-unused-export/after')).toEqual(['slop.unused_export:src/dates.ts:7']);
    expect(rules('slop-unused-export/before')).toEqual([]);
  });
});

describe('runBenchmark', () => {
  it('is deterministic and needs no engine for the fast lane', () => {
    const one = runBenchmark({ yaml: false });
    const two = runBenchmark({ yaml: false });
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(one.engines.yaml).toEqual({ status: 'unavailable', reason: 'disabled by --no-yaml' });
    // YAML-rule labels are skipped, not counted as misses, when the packs did not run.
    const sql = one.outcomes.find((o) => o.labelId === 'sast-sql-template');
    expect(sql?.kind).toBe('skipped');
  });

  it.skipIf(findYamlTool() === null)(
    'scores the rule fixtures at full recall with no false positives (the regression floor)',
    () => {
      const r = runBenchmark();
      const fixtures = r.bySuite.find((s) => s.suite === 'rule-fixtures')!.score;
      expect(fixtures).toMatchObject({ fn: 0, fp: 0, recall: 1, precision: 1 });
    },
    60_000,
  );
});
