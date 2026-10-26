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
  /**
   * W20-18 (UX_TODO X-08): the issue tracking this finding in another tool
   * (Jira, Linear, ...). http(s) only, checked by the API; null when none.
   */
  external_ticket_url?: string | null;
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
  /** Who raised it (W20-15, UX_TODO X-10). Optional for an older API. */
  found_by?: FoundBy;
  /** Which AI model judged it, on which connection (W20-25, UX_TODO X-10). */
  verified_by?: VerifiedBy | null;
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
  /**
   * W20-08 (UX_TODO FND-57): why the scanner thinks it applies, kept beside
   * the fix. Null when it would only repeat the recommendation.
   */
  rationale?: string | null;
  /** W20-08 (FND-66): dismissing or marking won't fix needs an admin. */
  dismiss_requires_admin?: boolean;
  /** W20-08 (FND-57): what the dependency scanner worked out, or null. */
  dependency?: DependencyEvidence | null;
  /** W9-11 risk engine: the price the list is sorted by, null when unpriced. */
  effective_risk?: number | null;
  /** act | schedule | track, null when unpriced. */
  risk_band?: string | null;
  /** W20-21 (FND-70): the pull request it was raised on, or null. */
  pull_request?: { number: number } | null;
  /** W20-21 (FND-25): when an accepted risk comes back for review (YYYY-MM-DD). */
  review_by?: string | null;
  /** W20-21 (FND-51): the newest scan that still saw it, or null. */
  last_seen_scan?: { id: number; commit_sha: string; at: string } | null;
}

/**
 * Statuses and dimensions as words (W20-13, UX_TODO FND-26). Built with
 * `replace('_', ' ')` they read as code: "wont fix", "code health",
 * "dependency_health" (only the first underscore went).
 */
export const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
  resolved: 'Resolved',
  wont_fix: "Won't fix",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, ' ');
}

export const DIMENSION_LABEL: Record<string, string> = {
  code_health: 'Code health',
  security: 'Security',
  performance: 'Performance',
  test_coverage: 'Test coverage',
  best_practices: 'Best practices',
  ai_slop: 'AI slop (model review)',
  secrets: 'Secrets',
  dependency: 'Dependencies',
  sast: 'Static analysis (SAST)',
  iac: 'Infrastructure as code',
  chain: 'Attack chain',
  compound: 'Compound',
  logging: 'Logging',
  slop: 'AI slop (scanner)',
  knowledge: 'Knowledge',
  dependency_health: 'Dependency health',
  architecture: 'Architecture',
  test_gap: 'Test gap',
};

export function dimensionLabel(dimension: string): string {
  const known = DIMENSION_LABEL[dimension];
  if (known) return known;
  const words = dimension.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Risk bands in words (W20-13, FND-19 / FND-64). */
export const RISK_BAND_LABEL: Record<string, string> = {
  act: 'Act now',
  schedule: 'Schedule',
  track: 'Track',
};

/**
 * Age since first seen, in the largest whole unit ("3d", "5w", "4mo").
 * W20-13 (FND-19): the list had no age column.
 */
export function ageOf(firstSeenAt: string, now: number = Date.now()): string {
  const days = Math.floor((now - new Date(firstSeenAt).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 1) return 'today';
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 730) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** GET /findings/:id `dependency` (W20-08, UX_TODO FND-57). */
export interface DependencyEvidence {
  /** manifest_only | imported | symbol_reachable | proven_unreachable. */
  reachability: string | null;
  usage: string | null;
  usage_evidence: { file: string; line: number | null; quote: string | null }[];
  call_sites: { file: string; line: number | null; symbol: string | null }[];
  scope: { kind: string; depth: number | null } | null;
  epss: number | null;
  aliases: string[];
}

/** GET /findings → found_by (W20-15, UX_TODO X-10). */
export type FoundBy =
  | {
      kind: 'imported';
      tool: string;
      source: 'sarif' | 'code_scanning';
      tool_version: string | null;
    }
  | { kind: 'model'; model: string }
  | { kind: 'scanner'; scanner: string; version: string | null }
  | { kind: 'unknown' };

/**
 * "Found by: …" in words (W20-15, UX_TODO X-10). The panel said only "Tier 1"
 * or "Tier 2", so another tool's opinion looked like RepoPulse's own and a
 * model's judgement looked like a rule's.
 */
export function foundByText(f: {
  found_by?: FoundBy;
  tier: number;
  rule_id?: string | null;
}): string {
  const by = f.found_by;
  if (!by || by.kind === 'unknown') return `Tier ${f.tier}`;
  if (by.kind === 'imported') {
    const via = by.source === 'sarif' ? 'a SARIF upload' : 'code scanning';
    return `Found by: imported from ${by.tool}${by.tool_version ? ` v${by.tool_version}` : ''} (${via})`;
  }
  if (by.kind === 'model') return `Found by: your AI model ${by.model}`;
  const rule = f.rule_id ? `, rule ${f.rule_id}` : '';
  return `Found by: the ${by.scanner.replace(/_/g, ' ')} scanner${by.version ? ` ${by.version}` : ''}${rule}`;
}

/** GET /findings → verified_by (W20-25, UX_TODO X-10). */
export interface VerifiedBy {
  model: string;
  connection: string | null;
  verdict: string | null;
  at: string | null;
}

const VERDICT_WORDS: Record<string, string> = {
  real: 'judged real',
  likely_false_positive: 'judged a likely false positive',
  needs_human: 'left for a person to judge',
};

/**
 * "verified by <model> (<connection>): judged real" beside "Found by" (W20-25,
 * UX_TODO X-10). Null when no model has judged the finding.
 */
export function verifiedByText(v: VerifiedBy | null | undefined): string | null {
  if (!v) return null;
  const via = v.connection ? ` (${v.connection})` : '';
  const said = v.verdict ? `: ${VERDICT_WORDS[v.verdict] ?? v.verdict.replace(/_/g, ' ')}` : '';
  return `verified by ${v.model}${via}${said}`;
}

/** Each reachability tier in a sentence a person can act on (FR-SEC-13). */
export const REACHABILITY_LABEL: Record<string, string> = {
  manifest_only: 'Listed in a manifest, and no import of it was found.',
  imported: 'Imported by this repository; no call to the vulnerable function was traced.',
  symbol_reachable: 'This repository calls a function the advisory names.',
  proven_unreachable: 'No call path to the vulnerable function was found.',
};

/**
 * `?status=` values the Findings filter offers (W20-08, UX_TODO FND-49).
 *
 * `active` (open AND confirmed) is the default and means what every "N open"
 * count on the Security tab and Sensitive changes means. `open` alone dropped
 * a finding from the default list the moment someone confirmed it, which is
 * exactly when it still needs fixing.
 */
export const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'active', label: 'Still to fix (open + confirmed)' },
  { value: 'open', label: 'Open' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'wont_fix', label: "Won't fix" },
];

/** Rows per page of GET /findings (the API's PAGE_SIZE). */
export const FINDINGS_PAGE_SIZE = 50;

/** The default status filter, left out of the URL (W20-08). */
export const DEFAULT_STATUS_FILTER = 'active';

/** The API's minimum for a dismissal or won't-fix note (W20-08, FND-66). */
export const DISMISS_NOTE_MIN = 10;

/**
 * Whether a finding closes by itself once the code is fixed (W20-08, UX_TODO
 * FND-58), said in the panel so nobody waits for a re-scan that will never
 * close it. The scanners listed sweep their own findings on a full run; a
 * model's judgement, a secret in history and a checklist answer do not.
 */
const AUTO_CLOSING_SCANNERS: Record<string, string> = {
  semgrep: 'the next weekly security scan',
  code_health_tools: 'the next code health scan',
  performance: 'the next weekly scan',
  logging_hygiene: 'the next weekly scan',
  anti_slop: 'the next weekly scan that reads the whole tree',
  supply_chain_register: 'the next nightly dependency register run',
  dependency_cve: 'the next dependency scan',
  // W21-05: the snapshot half runs inside the dependency scan and sweeps.
  slopsquat: 'the next dependency scan',
  container_image: 'the next image scan',
};

export function autoCloseNote(finding: {
  scanner_key?: string | null;
  rule_id?: string | null;
}): string {
  const when = finding.scanner_key ? AUTO_CLOSING_SCANNERS[finding.scanner_key] : undefined;
  if (when && !(finding.rule_id ?? '').endsWith('.judgment')) {
    return `Closes on its own when ${when} no longer finds it. Mark fixed to close it sooner.`;
  }
  return 'Does not close on its own: no later scan re-checks it. Mark it fixed once the code is fixed.';
}

/** OpenVEX statuses a person may record (W20-08, UX_TODO FND-05). */
export const VEX_STATUSES = [
  { value: 'not_affected', label: 'Not affected' },
  { value: 'affected', label: 'Affected' },
  { value: 'fixed', label: 'Fixed' },
] as const;

/** OpenVEX justifications, required with not_affected (SRS FR-SEC-14). */
export const VEX_JUSTIFICATIONS = [
  { value: 'component_not_present', label: 'The component is not present' },
  { value: 'vulnerable_code_not_present', label: 'The vulnerable code is not present' },
  {
    value: 'vulnerable_code_not_in_execute_path',
    label: 'The vulnerable code is never executed',
  },
  {
    value: 'vulnerable_code_cannot_be_controlled_by_adversary',
    label: 'An attacker cannot control the vulnerable code',
  },
  { value: 'inline_mitigations_already_exist', label: 'Mitigations are already in place' },
] as const;

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
  /** Findings a person has judged: the rate's denominator (W20-13, FND-71). */
  triaged?: number;
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
  /** W20-21 (FND-51): the scan that caused this move (an auto-close or reopen). */
  scan?: { id: number; commit_sha: string; at: string } | null;
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
 * The absolute link to a finding in RepoPulse (W20-15, UX_TODO X-07). The web
 * app is served from PUBLIC_BASE_URL, so the page's own origin is that URL.
 */
export function findingUrl(id: number, origin: string = window.location.origin): string {
  return `${origin.replace(/\/+$/, '')}/findings?finding=${id}`;
}

/**
 * A short name for a tracker link (W20-18, UX_TODO X-08): its host and last
 * path part, e.g. "linear.app ENG-142". Null for anything that is not an
 * http(s) URL, so it is never rendered as a link.
 */
export function ticketLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? `${u.host} ${decodeURIComponent(last)}` : u.host;
  } catch {
    return null;
  }
}

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
export function reviewSummary(
  finding: Finding,
  history: readonly FindingEvent[] = [],
  origin: string = window.location.origin,
): string {
  const lines = [
    `Finding #${finding.id}: ${finding.title}`,
    // Back to the finding itself (W20-15, UX_TODO X-07): the ticket or chat
    // message this is pasted into is read by someone who needs to open it.
    `In RepoPulse: ${findingUrl(finding.id, origin)}`,
    `Repository: ${finding.repo.org}/${finding.repo.name}`,
    `Location: ${locationOf(finding)}`,
    `Severity: ${(SEVERITY_LABEL[finding.severity] ?? String(finding.severity)).replace(/^[●○] /, '')}` +
      ` · confidence ${finding.confidence}/5 · ${dimensionLabel(finding.dimension)}`,
    `Status: ${statusLabel(finding.status)}` +
      (finding.dismiss_reason ? ` (${dismissReasonLabel(finding.dismiss_reason)})` : ''),
    `Verification: ${(VERIFY_LABEL[finding.verify_status] ?? finding.verify_status).replace(/^[✓✕·]+ /, '')}`,
    ...(finding.forge ? [`Link: ${finding.forge.url}`] : []),
    // W20-18 (UX_TODO X-08): where the work on it is tracked.
    ...(ticketLabel(finding.external_ticket_url) ? [`Ticket: ${finding.external_ticket_url}`] : []),
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
  // open → resolved: "Mark fixed" without a Confirm first (W20-08, FND-58).
  open: ['confirmed', 'resolved', 'dismissed', 'wont_fix'],
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

/**
 * Dismiss reasons in words, with what each one means (W20-13, UX_TODO
 * FND-25). The raw enums ("not applicable") left a reviewer guessing which one
 * the false-positive rate counts.
 */
export const DISMISS_REASON_LABEL: Record<DismissReason, { label: string; help: string }> = {
  false_positive: {
    label: 'False positive',
    help: 'The rule is wrong here: the code does not have this problem. Counts toward the rule’s false-positive rate.',
  },
  accepted_risk: {
    label: 'Accepted risk',
    help: 'The problem is real and the team accepts it. Say in the note who accepted it; it reopens on the review date for another look.',
  },
  not_applicable: {
    label: 'Not applicable',
    help: 'Real in general, but not in this context (test code, dead path, not shipped).',
  },
  duplicate: {
    label: 'Duplicate',
    help: 'Another finding already covers this. Name it in the note.',
  },
};

export function dismissReasonLabel(reason: string): string {
  // W20-21 (FND-61): set by "Record as rotated", never offered as a dismissal.
  if (reason === 'rotated') return 'Secret rotated';
  return isDismissReason(reason) ? DISMISS_REASON_LABEL[reason].label : reason.replace(/_/g, ' ');
}

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

/** Tomorrow as YYYY-MM-DD, the earliest review date the API accepts. */
export function tomorrow(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
