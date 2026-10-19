import { FINDING_DIMENSIONS } from '@repopulse/shared/dimensions';
// Findings wire contracts (W6-04). Source of truth: apps/api/src/routes/findings.

/** Every dimension the store can hold — analysis (W6) plus scanners (W8). */
/**
 * Every dimension the store can hold — analysis (W6), scanners (W8/W9) and the
 * structural registers (W10).
 *
 * W9-17: re-exported from @repopulse/shared/dimensions rather than kept in
 * step by hand. This copy and the API's agreed with each other while both
 * disagreed with the database, which is the drift that hid `slop` for a wave.
 * The subpath is dependency-free on purpose — the shared package index pulls
 * in postgres and pino, which must not reach a browser bundle.
 */
export const ALL_DIMENSIONS = FINDING_DIMENSIONS;

/**
 * Dimensions a user can select that NOTHING currently writes (W9-14).
 *
 * Every one of these is in the facet on purpose — each is specified, none is a
 * leftover — but a facet that returns an empty list without saying why is
 * indistinguishable from "your code is clean here", and that is the reading
 * this codebase keeps having to stamp out. The value is what the UI says when
 * a viewer picks one.
 *
 * This is the MIRROR of the defect W8-10 and W10-05 fixed: those were
 * dimensions that WERE produced and could not be filtered, and they showed you
 * everything. These are filterable and never produced, and they show you
 * nothing.
 */
export const DIMENSIONS_AWAITING_PRODUCER: Record<string, string> = {
  // FR-ANALYSIS-4 makes this a v1.x Tier-2 checklist dimension, and FR-REG-6
  // parks coverage ingestion outright. `test_gap` is the register dimension
  // that ships today and is a different question.
  test_coverage: 'Coverage ingestion is parked (FR-REG-6). Test-gap findings file under Test Gap.',
};

/** True when a dimension is selectable but cannot yet return anything. */
export function awaitingProducer(dimension: string): boolean {
  return dimension in DIMENSIONS_AWAITING_PRODUCER;
}

export interface Finding {
  id: number;
  repo: { id: number; org: string; name: string };
  dimension: string;
  severity: number;
  confidence: number;
  title: string;
  // Nullable since W8-02: a dependency CVE is a repo-level fact with no line.
  file: string | null;
  line_range: [number | null, number | null];
  evidence: string;
  /** Lines of the scanned file around the finding (W18-32), or null. */
  context?: { start_line: number; lines: string } | null;
  recommendation: string;
  status: string;
  dismiss_reason: string | null;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  tier: number;
  /** W6-05. 'unverified' is honest, not missing: nobody re-judged it. */
  verify_status: 'unverified' | 'confirmed' | 'contradicted';
  // W8-10 scanner delta. NULL on an analysis finding, and null rather than ''
  // so an absent rule id renders as nothing at all instead of a blank chip
  // that looks like a rendering bug.
  scanner_key?: string | null;
  rule_id?: string | null;
  cve_id?: string | null;
  chain_id?: string | null;
  scan_run_id?: number | null;
  kev?: boolean;
  /**
   * Where to open this in the forge (W16-41), or null when there is nothing
   * honest to link to — a repository-level finding has no file, and a
   * connection with no recorded base URL has no instance to point at.
   *
   * `ref_kind` is carried because it changes what the link MEANS: pinned to
   * the scan's commit it shows the code as it was when the finding was raised;
   * on the default branch it shows whatever is there now, which for a line
   * number is a different claim.
   */
  forge?: { url: string; ref_kind: 'commit' | 'branch' } | null;
  /**
   * W18-29. Raised by a rule still in SHADOW (CODE_HEALTH_SUITE §8.2): its
   * precision is being measured, so it is listed only when someone asks for
   * shadow findings, and always marked when it is.
   */
  experimental?: boolean;
}

/** The explorer's shadow facet — the API's `experimental` query value. */
export type ShadowMode = 'exclude' | 'only' | 'include';

/** GET /findings — one page, plus what the shadow default held back. */
export interface FindingPage {
  items: Finding[];
  next_cursor: string | null;
  experimental?: ShadowMode;
  /** Shadow findings matching the other filters that the default left out; null when none were held back by construction. */
  shadow_hidden?: number | null;
  /** Findings matching the filters across every page (W20-03). */
  total?: number;
}

/** GET /findings/facets (W18-29). */
export interface RuleFacet {
  rule_id: string;
  scanner_key: string | null;
  active: number;
  shadow: number;
  /** rule_registry status, or null when the rule runs as shipped. */
  lifecycle: string | null;
}

export interface FindingFacets {
  rules: RuleFacet[];
  shadow_total: number;
}

/** Paired glyph + word — a badge that relies on colour says nothing in print. */
export const VERIFY_LABEL: Record<string, string> = {
  confirmed: '✓✓ verified by a second model',
  contradicted: '✕ contradicted on review',
  unverified: '· not independently verified',
};

export interface FindingStats {
  by_dimension: { dimension: string; status: string; n: number }[];
  /** null = nothing triaged yet. NOT 0 — that would read as a flawless model. */
  false_positive_rate: number | null;
  false_positive_count: number;
  total: number;
}

export interface FindingEvent {
  from_status: string | null;
  to_status: string;
  actor: number | null;
  /**
   * The actor's login, kept beside the id so it survives their account
   * (W16-59). Present with a null `actor` means a person whose account has
   * since been removed — which is a different fact from `automatic`.
   */
  actor_login?: string | null;
  automatic: boolean;
  reason: string | null;
  at: string;
}

/** Paired word + glyph so severity never depends on colour (UX_SPEC §7). */
export const SEVERITY_LABEL: Record<number, string> = {
  5: '● critical',
  4: '● high',
  3: '● medium',
  2: '○ low',
  1: '○ info',
};

/**
 * The whole review, as plain text (W17-23).
 *
 * For pasting into a PR comment, a ticket, or a message — which is where a
 * review decision actually gets acted on, and none of those places is this
 * app. Plain text on purpose: markdown pasted into a plain field is noise, and
 * plain text pasted into a markdown field is still readable. It is BUILT from
 * what the panel already holds and never fetched, and it writes nowhere: the
 * clipboard is the only destination, and no forge is told anything.
 */
export function reviewSummary(finding: Finding, history: readonly FindingEvent[] = []): string {
  const lines = [
    `Finding #${finding.id}: ${finding.title}`,
    `Repository: ${finding.repo.org}/${finding.repo.name}`,
    `Location: ${locationOf(finding)}`,
    `Severity: ${(SEVERITY_LABEL[finding.severity] ?? String(finding.severity)).replace(/^[●○] /, '')}` +
      ` · confidence ${finding.confidence}/5 · ${finding.dimension.replace('_', ' ')}`,
    `Status: ${finding.status.replace('_', ' ')}` +
      (finding.dismiss_reason ? ` (${finding.dismiss_reason.replace('_', ' ')})` : ''),
    `Verification: ${(VERIFY_LABEL[finding.verify_status] ?? finding.verify_status).replace(/^[✓✕·]+ /, '')}`,
    ...(finding.forge ? [`Link: ${finding.forge.url}`] : []),
    '',
    'Evidence:',
    finding.evidence,
    '',
    'Recommendation:',
    finding.recommendation,
  ];
  if (history.length > 0) {
    lines.push('', 'History:');
    for (const e of history) {
      const who = e.automatic ? 'automatic' : (e.actor_login ?? 'a person');
      lines.push(
        `- ${e.at.slice(0, 10)} ${e.from_status ?? 'new'} → ${e.to_status} (${who}` +
          `${e.reason ? `: ${e.reason}` : ''})`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Where a finding is, in words a reader can act on (W16-40).
 *
 * NOT every finding is about a line of code. A test-gap or ownership register
 * reports on a REPOSITORY, and those rows carry `file: null` with a null line
 * range — which the two screens rendered as `{file}:{line}`, i.e. a bare colon.
 * Punctuation with nothing either side of it reads as a rendering bug, and the
 * reader learns nothing about a finding that is perfectly well located.
 */
export function locationOf(finding: {
  file: string | null;
  line_range: (number | null)[];
}): string {
  if (!finding.file) return 'whole repository';
  const [start, end] = finding.line_range;
  if (start === null || start === undefined) return finding.file;
  // A single-line finding says one number, not "10–10".
  return end === null || end === undefined || end === start
    ? `${finding.file}:${start}`
    : `${finding.file}:${start}–${end}`;
}

/**
 * The status changes a person may make from each status (W20-01, UX_TODO
 * FND-01). Mirrors HUMAN in packages/insights/src/findings/lifecycle.ts, which
 * the API enforces; the web app does not depend on insights, so the table is
 * repeated here and a test pins the two together.
 */
export type FindingLifecycleStatus = 'open' | 'confirmed' | 'dismissed' | 'resolved' | 'wont_fix';

export const FINDING_TRANSITIONS: Record<
  FindingLifecycleStatus,
  readonly FindingLifecycleStatus[]
> = {
  open: ['confirmed', 'dismissed', 'wont_fix'],
  confirmed: ['resolved', 'dismissed', 'wont_fix'],
  dismissed: ['open'],
  wont_fix: ['open'],
  resolved: ['open'],
};

export function allowedFindingTransitions(status: string): readonly FindingLifecycleStatus[] {
  return FINDING_TRANSITIONS[status as FindingLifecycleStatus] ?? [];
}

/** How each transition reads as a button, in the order it is offered. */
export const FINDING_ACTIONS: Record<
  FindingLifecycleStatus,
  { label: string; busy: string; testId: string; hint: string }
> = {
  confirmed: {
    label: 'Confirm',
    busy: 'Confirming…',
    testId: 'finding-confirm',
    hint: 'This is a real problem that should be fixed.',
  },
  resolved: {
    label: 'Mark fixed',
    busy: 'Marking fixed…',
    testId: 'finding-resolve',
    hint: 'The code was fixed. If the problem comes back in a later scan, the finding reopens on its own.',
  },
  wont_fix: {
    label: "Won't fix",
    busy: 'Saving…',
    testId: 'finding-wontfix',
    hint: 'Real, but the team accepts it. Later scans will not reopen it.',
  },
  dismissed: {
    label: 'Dismiss',
    busy: 'Dismissing…',
    testId: 'finding-dismiss',
    hint: 'Not a real problem here. Pick a reason so the rule can be measured.',
  },
  open: {
    label: 'Reopen',
    busy: 'Reopening…',
    testId: 'finding-reopen',
    hint: 'Put this finding back in the queue.',
  },
};

/** Reasons a dismissal may carry; the API's DISMISS_REASONS, in the order offered. */
export const DISMISS_REASONS = [
  'false_positive',
  'accepted_risk',
  'not_applicable',
  'duplicate',
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

export function isDismissReason(value: string): value is DismissReason {
  return (DISMISS_REASONS as readonly string[]).includes(value);
}

/**
 * The status an Undo would PATCH back to, or null when the lifecycle has no
 * way back (W20-03, UX_TODO FND-02).
 *
 * Undo is not a special power: it is the ordinary reverse transition, offered
 * only when the lifecycle the API enforces allows it. open → dismissed undoes
 * (dismissed → open is a reopen); open → confirmed does not, because nothing
 * goes from confirmed back to open, and offering a button the API will answer
 * with a 409 is the defect FND-01 removed.
 */
export function undoTargetFor(from: string, to: string): FindingLifecycleStatus | null {
  return allowedFindingTransitions(to).includes(from as FindingLifecycleStatus)
    ? (from as FindingLifecycleStatus)
    : null;
}

/** Past tense for a status message after a change ("Dismissed", "Reopened"). */
export const FINDING_DONE_LABEL: Record<FindingLifecycleStatus, string> = {
  confirmed: 'Confirmed',
  resolved: 'Marked fixed',
  wont_fix: "Marked won't fix",
  dismissed: 'Dismissed',
  open: 'Reopened',
};
