// Weekly Pulse (W6-06, R-A7).
//
// TEMPLATE FIRST, model second — and the ordering is the whole design. Every
// number in a bullet is computed here, from the warehouse. A Tier-2 pass may
// reword the sentences afterwards, but it is never given the opportunity to
// produce a figure, because a narrative that invents "review coverage improved
// 12%" is worse than no narrative: it is wrong in the register people quote.

export interface PulseDelta {
  /** Metric key, e.g. 'M5'. */
  key: string;
  label: string;
  /** Value at the end of the window, or null when not computed. */
  current: number | null;
  /** Value one window earlier, or null when there is nothing to compare to. */
  previous: number | null;
  /** Higher is better for this metric. */
  higherBetter: boolean;
  /** Rendering hint: 'ratio' formats as a percentage, 'count' as an integer. */
  unit: 'ratio' | 'count' | 'hours';
}

export interface PulseInput {
  repoLabel: string;
  windowDays: number;
  deltas: readonly PulseDelta[];
  openFindings: number;
  newFindingsThisWindow: number;
  /** Plan items that closed in the window, from the audit trail. */
  planItemsVerified: number;
}

export interface PulseBullet {
  /** Stable id so the UI can key bullets and a report can reference one. */
  id: string;
  text: string;
  /** 'up' | 'down' relative to the metric's own direction, or 'flat'/'unknown'. */
  direction: 'better' | 'worse' | 'flat' | 'unknown';
}

const PERCENT = (n: number): string => `${Math.round(n * 100)}%`;

function formatValue(value: number, unit: PulseDelta['unit']): string {
  if (unit === 'ratio') return PERCENT(value);
  if (unit === 'hours') return `${Math.round(value)}h`;
  return String(Math.round(value));
}

/**
 * One bullet for one metric.
 *
 * A metric with no previous value says "first measured", NOT "improved from
 * zero" — the most tempting lie in a weekly summary, because it makes every
 * new metric look like progress.
 */
export function deltaBullet(delta: PulseDelta): PulseBullet {
  if (delta.current === null) {
    return {
      id: delta.key,
      text: `${delta.label} was not computed this window.`,
      direction: 'unknown',
    };
  }
  const current = formatValue(delta.current, delta.unit);
  if (delta.previous === null) {
    return {
      id: delta.key,
      text: `${delta.label} is ${current} (first measured this window — no prior value to compare).`,
      direction: 'unknown',
    };
  }

  const change = delta.current - delta.previous;
  if (change === 0) {
    return { id: delta.key, text: `${delta.label} held at ${current}.`, direction: 'flat' };
  }
  const better = delta.higherBetter ? change > 0 : change < 0;
  const magnitude = formatValue(Math.abs(change), delta.unit);
  return {
    id: delta.key,
    // "from X to Y" rather than a bare percentage change: a reader can check
    // the claim against the dashboard, which is what makes it trustworthy.
    text: `${delta.label} ${better ? 'improved' : 'worsened'} by ${magnitude}, from ${formatValue(delta.previous, delta.unit)} to ${current}.`,
    direction: better ? 'better' : 'worse',
  };
}

/**
 * The deterministic five-bullet pulse.
 *
 * Exactly five, and always the same five slots: the biggest mover, findings,
 * plan progress, and the two next-largest movers. A summary whose shape changes
 * week to week cannot be skimmed, and skimming is the only way a weekly note
 * gets read at all.
 */
export function buildPulse(input: PulseInput): PulseBullet[] {
  const scored = input.deltas
    .map((d) => ({ delta: d, bullet: deltaBullet(d) }))
    .sort((a, b) => {
      // Movement first, unknowns last: "not computed" is honest but it is not
      // news, and leading with it buries the week's actual change.
      const rank = (x: PulseBullet) =>
        x.direction === 'unknown' ? 2 : x.direction === 'flat' ? 1 : 0;
      return rank(a.bullet) - rank(b.bullet);
    });

  const bullets: PulseBullet[] = [];
  bullets.push(
    scored[0]?.bullet ?? {
      id: 'no-metrics',
      text: 'No metrics were computed for this group this window.',
      direction: 'unknown',
    },
  );

  bullets.push({
    id: 'findings',
    text:
      input.openFindings === 0
        ? 'No findings are open.'
        : `${input.openFindings} findings are open${input.newFindingsThisWindow > 0 ? `, ${input.newFindingsThisWindow} raised this window` : ' (none new this window)'}.`,
    direction: input.newFindingsThisWindow > 0 ? 'worse' : 'flat',
  });

  bullets.push({
    id: 'plan',
    text:
      input.planItemsVerified > 0
        ? `${input.planItemsVerified} plan item${input.planItemsVerified === 1 ? '' : 's'} verified as done this window.`
        : 'No plan items were verified this window.',
    direction: input.planItemsVerified > 0 ? 'better' : 'flat',
  });

  for (const entry of scored.slice(1, 3)) bullets.push(entry.bullet);

  // Pad to exactly five so the card never reflows between weeks.
  while (bullets.length < 5) {
    bullets.push({
      id: `filler-${bullets.length}`,
      text: 'No further movement worth reporting.',
      direction: 'flat',
    });
  }
  return bullets.slice(0, 5);
}

/**
 * The prompt for the optional Tier-2 polish pass (pass_kind='narrate').
 *
 * It is given the finished bullets and told, explicitly and twice, that every
 * number is already correct and must be reproduced exactly. The model's only
 * job is prose. If it changes a figure the caller discards its output — see
 * `numbersPreserved`.
 */
export function buildNarratePrompt(bullets: readonly PulseBullet[], repoLabel: string): string {
  return [
    'Reword the following weekly summary bullets so they read naturally.',
    '',
    'RULES:',
    '- Every number is already correct. Reproduce each one EXACTLY.',
    '- Do not add any number, percentage, or comparison that is not present.',
    '- Do not draw conclusions beyond what the bullets state.',
    '- Keep one bullet per input bullet, in the same order.',
    '',
    `Group: ${repoLabel}`,
    ...bullets.map((b, i) => `${i + 1}. ${b.text}`),
    '',
    'Respond ONLY with JSON: {"bullets":["...","..."]}',
  ].join('\n');
}

/** Every number in the original must survive the rewording (R-A7). */
export function numbersPreserved(original: string, reworded: string): boolean {
  const numbers = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).sort();
  const before = numbers(original);
  const after = numbers(reworded);
  return before.length === after.length && before.every((n, i) => n === after[i]);
}

/**
 * Applies a polish pass, falling back to the deterministic text.
 *
 * The fallback is not defensive programming, it is the product decision: a
 * template bullet that reads a little stiffly is strictly better than a fluent
 * one with an invented number in it.
 */
export function applyNarration(
  bullets: readonly PulseBullet[],
  reworded: readonly string[],
): PulseBullet[] {
  if (reworded.length !== bullets.length) return [...bullets];
  return bullets.map((bullet, i) => {
    const candidate = reworded[i] ?? '';
    return numbersPreserved(bullet.text, candidate) && candidate.trim() !== ''
      ? { ...bullet, text: candidate }
      : bullet;
  });
}
