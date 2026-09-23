import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// axe a11y scan helper (ROADMAP W4 gate: axe on all MVP routes). Every screen
// spec calls this after the page settles; a violation fails the run with the
// offending rule ids.
export async function expectNoA11yViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    results.violations,
    `a11y violations: ${results.violations.map((v) => v.id).join(', ')}`,
  ).toEqual([]);
}

/**
 * One axe violation, flattened to what the evidence file needs (W17-31).
 *
 * axe's own result object carries every node's full HTML; the evidence only
 * needs enough to find the element again — the rule, its impact, the WCAG
 * tags, and the first few target selectors.
 */
export interface A11yViolationRecord {
  screen: string;
  id: string;
  impact: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: number;
  targets: string[];
  /** First offending node's markup, truncated — enough to find it again. */
  html?: string;
}

/**
 * Where W17-31 evidence goes. Set `W17_31_EVIDENCE_DIR` to write straight into
 * `docs/work/product-completion/evidence/...`; unset, it lands under
 * test-results/ (gitignored) so an ordinary `pnpm e2e` leaves the tree clean.
 */
export function evidenceDir(): string {
  const dir = process.env.W17_31_EVIDENCE_DIR ?? join('test-results', 'w17-31');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Append one JSON line to `<evidenceDir>/<file>`. */
export function recordEvidence(file: string, row: unknown): void {
  appendFileSync(join(evidenceDir(), file), `${JSON.stringify(row)}\n`);
}

/**
 * The W17-31 scan: fails on SERIOUS and CRITICAL only, and records every
 * violation — including the moderate and minor ones it lets through — to
 * `axe.jsonl` so the evidence names what was found rather than just what
 * failed.
 *
 * Deliberately separate from `expectNoA11yViolations`, which fails on any
 * impact and stays the standard for the screen specs. This one exists for the
 * acceptance wording of W17-31 ("no unexplained serious or critical") applied
 * to screens and STATES the older spec never reached — error, empty, narrow,
 * drawer open — where the strict bar has never been measured before and a
 * minor finding must be recorded, not hidden behind a skip.
 */
export async function expectNoSeriousA11yViolations(page: Page, screen: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  for (const v of results.violations) {
    const row: A11yViolationRecord = {
      screen,
      id: v.id,
      impact: v.impact ?? 'unknown',
      help: v.help,
      helpUrl: v.helpUrl,
      tags: v.tags,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
      html: v.nodes[0]?.html.slice(0, 300),
    };
    recordEvidence('axe.jsonl', row);
  }
  // A screen with zero violations still gets a line, so the evidence file
  // proves the scan RAN there — an absent row and a clean row must not look
  // the same.
  recordEvidence('axe-scans.jsonl', {
    screen,
    violations: results.violations.length,
    passes: results.passes.length,
    incomplete: results.incomplete.length,
  });

  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map(
      (v) => `${v.impact}:${v.id} (${v.nodes.length} nodes: ${v.nodes[0]?.target.join(' ')})`,
    ),
    `serious/critical a11y violations on ${screen}`,
  ).toEqual([]);
}
