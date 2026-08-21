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
  // SECURITY_SUITE.md §7 lists the IaC Checker as a backlog scanner and
  // reserves this dimension for it. Reserved, not forgotten.
  iac: 'No IaC scanner yet — the dimension is reserved for one (SECURITY_SUITE §7).',
  // FR-ANALYSIS-4 makes this a v1.x Tier-2 checklist dimension, and FR-REG-6
  // parks coverage ingestion outright. `test_gap` is the register dimension
  // that ships today and is a different question.
  test_coverage:
    'Coverage ingestion is parked (FR-REG-6). Test-gap findings file under Test Gap.',
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
