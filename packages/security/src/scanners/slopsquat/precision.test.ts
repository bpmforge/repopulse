import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectSnapshot } from './collect.js';
import { detectSlopsquats, type SlopSignal } from './detect.js';
import { normalizePackageName, type SlopEcosystem } from './names.js';
import { loadPopular } from './popular.js';
import { loadPackageIndex } from './registry-index.js';

// Precision and recall on the W21-05 corpus (fixtures/slopsquat/corpus.json).
//
// Real incidents where the public record names the package (each case cites
// its source), synthetic names where no incident covers an ecosystem — and
// 120 held-out REAL packages as controls, the hardest honest ones there are:
// moderately popular npm and PyPI names just outside the shipped popular
// lists. Every declaration in the fixture tree is labelled, so a signal on an
// unlabelled line fails the test rather than going uncounted.
//
// The floors below are the measured numbers rounded down, not targets: a
// change that lowers either has to say why in this file.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../../fixtures/slopsquat');

interface Case {
  manifest: string;
  ecosystem: SlopEcosystem;
  name: string;
  expect: 'slopsquat' | 'slopsquat.near-miss' | 'clean';
  kind: string;
}

const corpus = JSON.parse(readFileSync(path.join(FIXTURE, 'corpus.json'), 'utf8')) as {
  now: string;
  cases: Case[];
  controlManifests: string[];
};

const key = (manifest: string, eco: SlopEcosystem, name: string): string =>
  `${manifest}\0${eco}\0${normalizePackageName(eco, name)}`;

function score(signals: readonly SlopSignal[], cases: readonly Case[]) {
  const flagged = new Map(signals.map((s) => [key(s.manifest, s.ecosystem, s.name), s]));
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let ruleRight = 0;
  const misses: string[] = [];
  const falseAlarms: string[] = [];
  for (const c of cases) {
    const s = flagged.get(key(c.manifest, c.ecosystem, c.name));
    const positive = c.expect !== 'clean';
    if (positive && s) {
      tp += 1;
      if (s.ruleId === c.expect) ruleRight += 1;
    } else if (positive) {
      fn += 1;
      misses.push(c.name);
    } else if (s) {
      fp += 1;
      falseAlarms.push(`${c.name} (${s.ruleId}, ~${s.nearest?.target ?? '-'})`);
    }
  }
  return {
    tp,
    fp,
    fn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    ruleRight,
    misses,
    falseAlarms,
  };
}

describe('slopsquat precision/recall on the W21-05 corpus', () => {
  const tree = collectSnapshot(path.join(FIXTURE, 'repo'));
  const index = loadPackageIndex(path.join(FIXTURE, 'registry'));
  const result = detectSlopsquats({
    reads: tree.reads,
    resolved: tree.resolved,
    index,
    popular: loadPopular(),
    now: new Date(corpus.now),
    ownNames: tree.ownNames,
    privateScopes: tree.privateScopes,
  });

  // Every declaration, labelled: the cases plus each control manifest's lines.
  const labelled = new Map(corpus.cases.map((c) => [key(c.manifest, c.ecosystem, c.name), c]));
  const controls: Case[] = [];
  for (const read of tree.reads) {
    if (!corpus.controlManifests.includes(read.manifest)) continue;
    for (const d of read.declarations) {
      controls.push({
        manifest: read.manifest,
        ecosystem: d.ecosystem,
        name: d.name,
        expect: 'clean',
        kind: 'held-out',
      });
    }
  }
  const all = [...corpus.cases, ...controls];

  it('labels every declaration the readers found, and finds every labelled one', () => {
    const found = new Set<string>();
    for (const read of tree.reads) {
      for (const d of read.declarations) {
        const k = key(read.manifest, d.ecosystem, d.name);
        found.add(k);
        if (!corpus.controlManifests.includes(read.manifest)) {
          expect(labelled.has(k), `unlabelled declaration ${read.manifest} ${d.name}`).toBe(true);
        }
      }
    }
    for (const c of corpus.cases)
      expect(found.has(key(c.manifest, c.ecosystem, c.name)), `not read: ${c.name}`).toBe(true);
    expect(controls).toHaveLength(120);
  });

  it('meets the measured floors, overall and on real incidents alone', () => {
    const overall = score(result.signals, all);
    const realOnly = score(
      result.signals,
      all.filter((c) => !c.kind.startsWith('synthetic')),
    );
    // Per rule: a case counts for a rule when that rule is its label, and a
    // signal counts against a rule when the rule raised it on a clean line.
    const perRule = (rule: string) =>
      score(
        result.signals.filter((s) => s.ruleId === rule),
        all.filter((c) => c.expect === rule || c.expect === 'clean'),
      );
    const missing = perRule('slopsquat');
    const near = perRule('slopsquat.near-miss');
    const fmt = (r: ReturnType<typeof score>) => ({
      ...r,
      precision: r.precision.toFixed(3),
      recall: r.recall.toFixed(3),
    });
    const negatives = all.filter((c) => c.expect === 'clean').length;
    const report = {
      positives: all.length - negatives,
      negatives,
      overall: fmt(overall),
      real: fmt(realOnly),
      'rule slopsquat': fmt(missing),
      'rule slopsquat.near-miss': fmt(near),
    };
    // Printed so the numbers in the docs can be checked against a run.
    console.info(`[slopsquat corpus] ${JSON.stringify(report)}`);

    // Measured 2026-10-26: 15 of 16 positives found (the miss is atlas-client,
    // whose target RubyGems publishes no ranking for), 1 of 148 negatives
    // flagged (dom-serialize: a low-confidence near-miss of dom-serializer).
    // Overall P 0.938 / R 0.938; real incidents only P 0.900 / R 0.900; rule
    // `slopsquat` P 1.000 / R 1.000; rule `slopsquat.near-miss` P 0.857 /
    // R 0.857.
    expect(overall.recall).toBeGreaterThanOrEqual(0.93);
    expect(overall.precision).toBeGreaterThanOrEqual(0.93);
    expect(realOnly.recall).toBeGreaterThanOrEqual(0.9);
    expect(realOnly.precision).toBeGreaterThanOrEqual(0.9);
    // Not-in-registry is the rule a workspace would promote first: no false
    // alarm on any control.
    expect(missing.precision).toBe(1);
    expect(missing.recall).toBe(1);
    expect(near.precision).toBeGreaterThanOrEqual(0.85);
    expect(near.recall).toBeGreaterThanOrEqual(0.85);
    // Every true positive under the rule its label names.
    expect(overall.ruleRight).toBe(overall.tp);
    // Any false alarm is the weak kind: severity 3, confidence 2.
    for (const s of result.signals) {
      const c = labelled.get(key(s.manifest, s.ecosystem, s.name));
      if (!c || c.expect === 'clean') expect([s.severity, s.confidence]).toEqual([3, 2]);
    }
  });

  it('states what it could not check instead of reporting clean', () => {
    // The private-index manifest's one unpopular name is not checked, and says why.
    expect(result.notChecked.pypi?.reason).toMatch(/private index/);
  });
});
