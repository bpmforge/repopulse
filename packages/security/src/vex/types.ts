import type { VexJustification } from '../validation/index.js';

// VEX vocabulary and record shapes (W8-14, SECURITY_SUITE.md §3.6, FR-SEC-14).
//
// THE ARGUMENT THIS MODULE EXISTS TO MAKE: a suppressed vulnerability and an
// ignored one look identical in a findings list, and the difference is the
// whole of whether a security tool keeps a team's trust. So nothing here can
// dismiss a finding without recording WHO said so, WHICH versions they said it
// about, and — for `not_affected` — WHY, drawn from a fixed enum a reader is
// able to disagree with. "We looked and it does not apply" is a claim; this
// module is what makes it a checkable one.

export type { VexJustification };

/** The OpenVEX status vocabulary, verbatim (openvex_json_schema.json). */
export type VexStatus = 'not_affected' | 'affected' | 'fixed' | 'under_investigation';

export const VEX_STATUSES: readonly VexStatus[] = [
  'not_affected',
  'affected',
  'fixed',
  'under_investigation',
];

/**
 * The five OpenVEX justifications, verbatim and in spec order.
 *
 * A CLOSED SET on purpose. Free text here would let "not applicable" and "n/a
 * we think" be different answers to the same question, and neither would
 * survive an auditor asking what was actually checked.
 */
export const VEX_JUSTIFICATIONS: readonly VexJustification[] = [
  'component_not_present',
  'vulnerable_code_not_present',
  'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary',
  'inline_mitigations_already_exist',
];

export function isVexStatus(value: unknown): value is VexStatus {
  return typeof value === 'string' && (VEX_STATUSES as readonly string[]).includes(value);
}

export function isVexJustification(value: unknown): value is VexJustification {
  return typeof value === 'string' && (VEX_JUSTIFICATIONS as readonly string[]).includes(value);
}

/**
 * Statuses that stop a finding being re-filed.
 *
 * `fixed` is here with `not_affected` because both are assertions that the
 * scanner's match is no longer a live problem for this product. `affected` is
 * NOT: confirming a vulnerability is real is a reason to keep reporting it,
 * not to stop.
 */
export function suppresses(status: VexStatus): boolean {
  return status === 'not_affected' || status === 'fixed';
}

/**
 * A stored `vex_statements` row, as this module needs to read it.
 *
 * Structural rather than an import of the Drizzle row type: every function
 * below is pure and testable from a literal, and a table type would drag a
 * database dependency into a module whose entire job is to be checkable
 * offline.
 */
export interface VexStatementRecord {
  id: number;
  /** Versionless purl the statement is about — see `basePurl`. */
  packagePurl: string;
  /** Canonical vulnerability id, as `findings.rule_id` carries it. */
  vulnId: string;
  /** Versions the author looked at — see ./range.ts for the grammar. */
  versionRange: string;
  status: VexStatus;
  /** Required by the schema, the route and a CHECK constraint when not_affected. */
  justification: VexJustification | null;
  /** Free prose the author added. Never a substitute for the justification. */
  statusNotes: string | null;
  /** What the author was looking at: reachability tier, import refs, finding id. */
  evidence: Record<string, unknown>;
  /** Attributed to a person, never to "the system". */
  author: string;
  createdAt: Date;
}

/** One vulnerability as a scan observed it, which is all triage needs to match. */
export interface ObservedVulnerability {
  /** Preferred id — the CVE where the alias set carries one. */
  vulnId: string;
  /** Every other id the same vulnerability is known by (V0's output). */
  aliases: readonly string[];
  /** Full purl including version, as syft emitted it. */
  purl: string;
  /** The installed version the SBOM reports. */
  version: string;
  packageName: string;
}

/** What VEX says about one observed vulnerability, and why. */
export interface VexVerdict {
  status: VexStatus;
  /** The row that decided it, or null when nothing covers this observation. */
  statement: VexStatementRecord | null;
  /** True when a suppressing statement applies and this must not be re-filed. */
  suppressed: boolean;
  /**
   * True when a statement exists for this package and vulnerability but the
   * INSTALLED VERSION IS OUTSIDE the range its author examined.
   *
   * This is the case the whole design turns on: an upgrade (or a downgrade)
   * moves the code out from under the evidence, and a suppression that outlived
   * its evidence is indistinguishable from a bug nobody is looking at. Such a
   * finding comes back as `under_investigation`, loudly.
   */
  reopened: boolean;
  /** The sentence explaining this verdict, for the UI and the export. */
  reason: string;
}
