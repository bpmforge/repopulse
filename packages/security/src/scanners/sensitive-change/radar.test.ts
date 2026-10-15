import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHALLENGE_SEVERITY_FLOOR, mayBeSurfacedLoudly } from '@repopulse/analysis';
import { parseGitDiff, patchLines } from './patch.js';
import { RADAR_SEVERITY_CAP, languageOf, sensitiveChanges } from './radar.js';
import { RADAR_RULES } from './rules.js';
import { HUMAN_REVIEW_PREFIX, toRadarFinding } from './run.js';

// The sensitive-change radar's fixtures (W18-21).
//
// Every rule has at least one TRIGGERING fixture named after it, and the clean
// directory holds the near-misses the rules were written against: a guard
// hoisted into router.use, a route moved between files, a test file, a new
// file, a setting merely reindented. The fixtures are real `git diff` output,
// so a false positive seen in the field can be pasted in as a new clean case.

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '../../../fixtures/sensitive-change');

function load(dir: 'triggering' | 'clean') {
  return readdirSync(path.join(FIXTURES, dir))
    .filter((f) => f.endsWith('.diff'))
    .sort()
    .map((name) => ({
      name,
      files: parseGitDiff(readFileSync(path.join(FIXTURES, dir, name), 'utf8')),
    }));
}

const triggering = load('triggering');
const clean = load('clean');

describe('every radar rule has a triggering fixture', () => {
  it.each(RADAR_RULES.map((r) => r.id))('%s', (id) => {
    const slug = id.replace(/^sensitive\./, '');
    expect(triggering.some((f) => f.name.startsWith(`${slug}.`))).toBe(true);
  });

  it('covers JS/TS and Python for every rule', () => {
    for (const rule of RADAR_RULES) {
      const slug = rule.id.replace(/^sensitive\./, '');
      const langs = new Set(
        triggering
          .filter((f) => f.name.startsWith(`${slug}.`))
          .flatMap((f) => f.files.map((file) => languageOf(file.path))),
      );
      expect([...langs].sort(), rule.id).toEqual(['js', 'py']);
    }
  });
});

describe('triggering fixtures fire exactly their rule', () => {
  it.each(triggering.map((f) => [f.name, f] as const))('%s', (name, fixture) => {
    expect(fixture.files.length, 'fixture parsed').toBeGreaterThan(0);
    const expected = `sensitive.${name.split('.')[0]}`;
    const { signals } = sensitiveChanges(fixture.files);
    // Exactly one rule: two findings for one change is two triage decisions
    // for one question.
    expect([...new Set(signals.map((s) => s.ruleId))]).toEqual([expected]);
  });
});

describe('clean fixtures (near misses) fire nothing', () => {
  it.each(clean.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(fixture.files.length, 'fixture parsed').toBeGreaterThan(0);
    const { signals } = sensitiveChanges(fixture.files);
    expect(signals.map((s) => `${s.ruleId} @ ${s.file}:${s.line} ${s.evidence}`)).toEqual([]);
  });
});

describe('what a signal says', () => {
  const express = triggering.find((f) => f.name === 'authz_check_removed.express.diff')!;

  it('points at the PR line and quotes the removed line verbatim', () => {
    const [s] = sensitiveChanges(express.files).signals;
    expect(s).toMatchObject({
      file: 'src/routes/users.ts',
      // The removed line sat at 12; its replacement now occupies 12.
      line: 12,
      evidence: "- router.delete('/users/:id', requireAdmin, deleteUser);",
    });
  });

  it('shows before and after for a lowered number', () => {
    const bcrypt = triggering.find((f) => f.name === 'crypto_parameter_lowered.bcrypt.diff')!;
    const [s] = sensitiveChanges(bcrypt.files).signals;
    expect(s?.evidence).toBe('- const SALT_ROUNDS = 12; → + const SALT_ROUNDS = 8;');
  });

  it('compares rates across units: 5/minute → 1000/hour is looser', () => {
    const flask = triggering.find((f) => f.name === 'rate_limit_raised.flask.diff')!;
    expect(sensitiveChanges(flask.files).signals).toHaveLength(1);
  });

  it('says "needs human review" in the title and the rationale', () => {
    for (const fixture of triggering) {
      for (const s of sensitiveChanges(fixture.files).signals) {
        const finding = toRadarFinding(s, true);
        expect(finding.title.startsWith(`${HUMAN_REVIEW_PREFIX}: `), fixture.name).toBe(true);
        expect(finding.rationale).toMatch(/needs human review/);
        expect(finding.experimental).toBe(true);
      }
    }
  });

  it('never names a person (N-9): the finding has no field that could', () => {
    const [s] = sensitiveChanges(express.files).signals;
    const keys = Object.keys(toRadarFinding(s!, true));
    for (const key of keys) expect(key).not.toMatch(/author|login|user|identity|email/i);
  });
});

describe('never at the mercy of the verify pass', () => {
  it('caps severity below the challenge floor, so no confirmation is needed to surface', () => {
    // FR-ANALYSIS-10 hides severity >= 4 until a second model CONFIRMS it.
    // The radar never goes through that pass, so the cap is what guarantees a
    // radar finding is shown as it is rather than parked behind a verdict.
    expect(RADAR_SEVERITY_CAP).toBeLessThan(CHALLENGE_SEVERITY_FLOOR);
    for (const fixture of triggering) {
      for (const s of sensitiveChanges(fixture.files).signals) {
        expect(s.severity).toBeLessThanOrEqual(RADAR_SEVERITY_CAP);
        expect(mayBeSurfacedLoudly({ severity: s.severity, verifyStatus: 'unverified' })).toBe(
          true,
        );
      }
    }
  });
});

describe('rule metadata', () => {
  it('ids are {domain}.{slug} and unique', () => {
    const ids = RADAR_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^sensitive\.[a-z0-9_]+$/);
  });
});

describe('reading a patch', () => {
  it('numbers removed lines by where they sat in the new file', () => {
    const lines = patchLines(['@@ -5,4 +5,3 @@', ' a', '-b', '+c', ' d'].join('\n'));
    expect(lines).toEqual([
      { side: 'removed', text: 'b', line: 6, hunk: 0 },
      { side: 'added', text: 'c', line: 6, hunk: 0 },
    ]);
  });

  it('skips files the radar cannot judge, and counts them', () => {
    const r = sensitiveChanges([
      { path: 'README.md', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
      { path: 'src/a.ts', status: 'modified', patch: null },
      { path: 'src/a.test.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
      { path: 'src/new.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+a' },
      { path: 'src/pages/Admin.tsx', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
    ]);
    expect(r.scanned).toBe(0);
    expect(r.skipped).toEqual({
      noPatch: 1,
      notCode: 1,
      testOrFixture: 1,
      clientSide: 1,
      addedOrDeleted: 1,
    });
  });
});
