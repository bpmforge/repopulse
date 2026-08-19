import { describe, expect, it } from 'vitest';
import { applySuppression, intentWarnings, type FileIntent, type HotspotPoint } from './index.js';

// Artifact intents (W6-07, FR-PLANS-5).

const NOW = new Date('2026-08-19T00:00:00Z');
const monthsAgo = (n: number) => new Date(NOW.getTime() - n * 30 * 24 * 60 * 60 * 1000);

const intent = (over: Partial<FileIntent> = {}): FileIntent => ({
  repoId: 1,
  path: 'src/hot.ts',
  intent: 'refactor',
  createdAt: monthsAgo(4),
  warnAfterMonths: 3,
  ...over,
});

const history = (...pairs: [number, number][]): HotspotPoint[] =>
  pairs.map(([months, score]) => ({ at: monthsAgo(months), score }));

describe('refactor intents', () => {
  it('warns when the score has not improved within the window', () => {
    // A refactor intent is a promise with a date on it. If nothing improved,
    // the promise quietly expired, and saying so is the whole value of having
    // recorded it — an intent nobody is reminded about is a comment.
    const warnings = intentWarnings(intent(), history([4, 0.8], [1, 0.85]), NOW);
    expect(warnings[0]).toMatchObject({ kind: 'refactor_stalled', from: 0.8, to: 0.85 });
  });

  it('treats FLAT as not improved', () => {
    // Holding a hotspot score steady for four months is not a refactor.
    expect(intentWarnings(intent(), history([4, 0.8], [1, 0.8]), NOW)).toHaveLength(1);
  });

  it('stays quiet when the score actually improved', () => {
    expect(intentWarnings(intent(), history([4, 0.8], [1, 0.4]), NOW)).toEqual([]);
  });

  it('stays quiet before the window elapses', () => {
    const young = intent({ createdAt: monthsAgo(1) });
    expect(intentWarnings(young, history([1, 0.8], [0, 0.9]), NOW)).toEqual([]);
  });

  it('ignores improvement that happened BEFORE the intent was declared', () => {
    // Otherwise a file that was already getting better would credit the intent
    // for work that predates it.
    const declared = intent({ createdAt: monthsAgo(4) });
    const warnings = intentWarnings(declared, history([10, 0.95], [4, 0.8], [1, 0.85]), NOW);
    expect(warnings[0]).toMatchObject({ from: 0.8, to: 0.85 });
  });
});

describe('supervise intents', () => {
  it('alerts on ANY decline, with no grace period', () => {
    // The point of supervising is to hear about it early.
    const warnings = intentWarnings(
      intent({ intent: 'supervise', createdAt: monthsAgo(1) }),
      history([1, 0.3], [0, 0.35]),
      NOW,
    );
    expect(warnings[0]?.kind).toBe('supervised_decline');
  });

  it('stays quiet while the file is stable or improving', () => {
    const stable = intentWarnings(
      intent({ intent: 'supervise' }),
      history([2, 0.3], [0, 0.3]),
      NOW,
    );
    expect(stable).toEqual([]);
  });
});

describe('acknowledged intents', () => {
  it('never warns — the team already decided', () => {
    // An intent that keeps nagging after an explicit decision is why people
    // stop using intents at all.
    const warnings = intentWarnings(
      intent({ intent: 'acknowledged', createdAt: monthsAgo(12) }),
      history([12, 0.5], [0, 0.99]),
      NOW,
    );
    expect(warnings).toEqual([]);
  });

  it('suppresses the file from the leaderboard but reports the count', () => {
    // Hidden from the LIST, never from the data. A leaderboard that silently
    // omits rows is one nobody can reason about — and the first person to
    // notice stops trusting every other number on the screen.
    const rows = [
      { path: 'src/a.ts', score: 0.9 },
      { path: 'src/known.ts', score: 0.8 },
    ];
    const result = applySuppression(rows, [intent({ path: 'src/known.ts', intent: 'acknowledged' })]);
    expect(result.visible.map((r) => r.path)).toEqual(['src/a.ts']);
    expect(result.suppressedCount).toBe(1);
    expect(result.suppressedPaths).toEqual(['src/known.ts']);
  });

  it('does not suppress for refactor or supervise intents', () => {
    // Only "we have decided to live with this" hides a row. A file someone
    // means to fix should stay visible precisely because they mean to fix it.
    const rows = [{ path: 'src/a.ts', score: 0.9 }];
    expect(applySuppression(rows, [intent({ path: 'src/a.ts' })]).visible).toHaveLength(1);
    expect(
      applySuppression(rows, [intent({ path: 'src/a.ts', intent: 'supervise' })]).visible,
    ).toHaveLength(1);
  });
});
