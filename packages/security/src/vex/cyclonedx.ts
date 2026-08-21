import { basePurl } from './range.js';
import type { VexJustification, VexStatementRecord, VexStatus } from './types.js';

// CycloneDX-embedded VEX export (W8-14, FR-SEC-14, bom-1.7.schema.json).
//
// The SBOM this repository already stores, with a `vulnerabilities` array added
// carrying each statement as an `analysis` block. Embedded rather than served
// as a second document because the whole value of CycloneDX VEX is that the
// component list and the assessment travel together: a consumer resolving
// `affects[].ref` against a bom-ref is looking at the exact component the
// assessment was written about, which a standalone file cannot promise.
//
// ── THE LOSSY BIT, WHICH IS THE INTERESTING BIT ───────────────────────────────
//
// CycloneDX's `impactAnalysisJustification` is NOT the OpenVEX justification
// enum. It is a different vocabulary written for a different purpose, and the
// map below is neither onto nor one-to-one:
//
//   * `component_not_present` and `vulnerable_code_not_present` BOTH land on
//     `code_not_present`. CycloneDX has no way to say "the component is not
//     shipped at all" as distinct from "it ships but the vulnerable function
//     was tree-shaken out", so a round trip through this export cannot recover
//     which of the two the author meant.
//   * `vulnerable_code_cannot_be_controlled_by_adversary` has NO twin. The
//     nearest is `protected_by_mitigating_control`, and it is not the same
//     claim: the OpenVEX term says an attacker cannot influence the inputs,
//     which may be true incidentally, while the CycloneDX term says somebody
//     deliberately put a control in place.
//
// So the VERBATIM OpenVEX justification is written into `analysis.detail` on
// every statement. The mapped enum is what CycloneDX consumers read; the detail
// is what stops the original claim being destroyed by the translation. Every
// enum value below was read out of the vendored schema's own `meta:enum`
// descriptions rather than from memory, and the export is validated against
// that schema — an OpenVEX string emitted into a CycloneDX field fails the
// validator instead of shipping.

const STATE_BY_STATUS: Record<VexStatus, string> = {
  // "The component or service is not affected by the vulnerability."
  not_affected: 'not_affected',
  // "The vulnerability may be directly or indirectly exploitable." Confirming a
  // finding is real is the closest CycloneDX gets to OpenVEX's `affected`.
  affected: 'exploitable',
  // "The vulnerability has been remediated."
  fixed: 'resolved',
  // "The vulnerability is being investigated."
  under_investigation: 'in_triage',
};

const JUSTIFICATION_MAP: Record<VexJustification, string> = {
  component_not_present: 'code_not_present',
  vulnerable_code_not_present: 'code_not_present',
  // "The vulnerable code is not invoked at runtime." The one clean twin.
  vulnerable_code_not_in_execute_path: 'code_not_reachable',
  vulnerable_code_cannot_be_controlled_by_adversary: 'protected_by_mitigating_control',
  // "Exploits are prevented at runtime" — which is what an inline mitigation
  // shipped inside the product does.
  inline_mitigations_already_exist: 'protected_at_runtime',
};

export interface EmbedResult {
  document: Record<string, unknown>;
  /**
   * Statements whose package matched no component in this SBOM.
   *
   * REPORTED, NOT DROPPED SILENTLY. It means the statement and the SBOM are
   * about different commits — the dependency was removed, or the statement
   * predates the component list — and the export says so rather than emitting
   * an `affects[].ref` pointing at a bom-ref that is not in the document, which
   * would fail the schema and be right to.
   */
  unmatched: VexStatementRecord[];
}

/**
 * Adds a `vulnerabilities` array to a stored CycloneDX SBOM.
 *
 * The input document is not mutated: the stored SBOM is the evidence a finding
 * was computed against (W8-06), and an exporter that edited it in place would
 * make the record depend on who had asked for a download.
 */
export function embedVex(
  sbom: Record<string, unknown>,
  statements: readonly VexStatementRecord[],
): EmbedResult {
  const refsByPurl = componentRefs(sbom);
  const unmatched: VexStatementRecord[] = [];
  const vulnerabilities: Record<string, unknown>[] = [];

  for (const statement of statements) {
    const refs = refsByPurl.get(basePurl(statement.packagePurl)) ?? [];
    if (refs.length === 0) {
      unmatched.push(statement);
      continue;
    }
    vulnerabilities.push(vulnerabilityEntry(statement, refs));
  }

  return {
    document: { ...sbom, vulnerabilities },
    unmatched,
  };
}

function vulnerabilityEntry(
  statement: VexStatementRecord,
  refs: readonly string[],
): Record<string, unknown> {
  return {
    id: statement.vulnId,
    source: sourceFor(statement.vulnId),
    analysis: {
      state: STATE_BY_STATUS[statement.status],
      ...(statement.justification
        ? { justification: JUSTIFICATION_MAP[statement.justification] }
        : {}),
      detail: detailFor(statement),
      firstIssued: statement.createdAt.toISOString(),
      lastUpdated: statement.createdAt.toISOString(),
    },
    affects: refs.map((ref) => ({
      ref,
      // The range the author examined, in CycloneDX's own range field. Without
      // it the assessment reads as covering every version of the component,
      // which is the claim this whole subsystem refuses to let anyone make by
      // accident.
      versions: [{ range: statement.versionRange, status: 'affected' }],
    })),
  };
}

/**
 * The prose that survives the enum translation.
 *
 * Leads with the verbatim OpenVEX term because that is the lossy part — see
 * the header. A consumer who cares which of `component_not_present` and
 * `vulnerable_code_not_present` was meant can only find out here.
 */
function detailFor(statement: VexStatementRecord): string {
  const parts = [
    `OpenVEX status '${statement.status}'` +
      (statement.justification
        ? `, justification '${statement.justification}' (mapped to CycloneDX ` +
          `'${JUSTIFICATION_MAP[statement.justification]}', which is not an exact twin)`
        : '') +
      `, recorded by ${statement.author} for versions ${statement.versionRange}.`,
  ];
  if (statement.statusNotes) parts.push(statement.statusNotes);
  return parts.join(' ');
}

function sourceFor(vulnId: string): Record<string, unknown> {
  if (vulnId.startsWith('GHSA-')) {
    return { name: 'GitHub Advisory Database', url: `https://github.com/advisories/${vulnId}` };
  }
  if (vulnId.startsWith('CVE-')) {
    return { name: 'NVD', url: `https://nvd.nist.gov/vuln/detail/${vulnId}` };
  }
  return { name: 'OSV', url: `https://osv.dev/vulnerability/${vulnId}` };
}

/**
 * bom-refs by versionless purl.
 *
 * A list per purl, not a single ref: syft catalogues the same package once per
 * location it found it, so one dependency can legitimately hold several
 * bom-refs, and picking one would leave the assessment silently not applying to
 * the others.
 */
function componentRefs(sbom: Record<string, unknown>): Map<string, string[]> {
  const byPurl = new Map<string, string[]>();
  const components = Array.isArray(sbom['components']) ? sbom['components'] : [];
  for (const entry of components) {
    const component = entry as { purl?: unknown; 'bom-ref'?: unknown };
    if (typeof component.purl !== 'string' || typeof component['bom-ref'] !== 'string') continue;
    const key = basePurl(component.purl);
    const refs = byPurl.get(key) ?? [];
    refs.push(component['bom-ref']);
    byPurl.set(key, refs);
  }
  return byPurl;
}
