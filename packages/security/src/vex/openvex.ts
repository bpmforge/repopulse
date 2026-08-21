import { basePurl } from './range.js';
import type { VexStatementRecord } from './types.js';

// OpenVEX export (W8-14, FR-SEC-14, openvex_json_schema.json v0.2.0).
//
// Built to the vendored schema, and the tests VALIDATE against it rather than
// comparing to a golden file — a golden file only ever proves the exporter
// still does what it did last week.
//
// TWO CONDITIONAL REQUIREMENTS live in that schema, and both of them are real
// product rules rather than paperwork:
//   * `not_affected` MUST carry a justification or an impact_statement. This is
//     the same gate the triage route enforces with a 400, which means the
//     export cannot be the place an unjustified dismissal leaks out — the
//     schema would reject the document.
//   * `affected` MUST carry an action_statement. "This is real" is not a
//     finished thought; the schema insists the author also say what to do.

export const OPENVEX_CONTEXT = 'https://openvex.dev/ns/v0.2.0';

export interface OpenVexOptions {
  /** Attributed to a person or a workspace, never to "the scanner". */
  author: string;
  /** Stable, dereferenceable-shaped identity for this document. */
  documentId: string;
  timestamp: Date;
  /** Bumped by the caller when a document at the same @id is re-issued. */
  version?: number;
}

export function openVexDocument(
  statements: readonly VexStatementRecord[],
  options: OpenVexOptions,
): Record<string, unknown> {
  return {
    '@context': OPENVEX_CONTEXT,
    '@id': options.documentId,
    author: options.author,
    timestamp: options.timestamp.toISOString(),
    version: options.version ?? 1,
    tooling: 'RepoPulse dependency scanner (W8)',
    statements: statements.map(openVexStatement),
  };
}

function openVexStatement(statement: VexStatementRecord): Record<string, unknown> {
  const product = basePurl(statement.packagePurl);
  return {
    vulnerability: { name: statement.vulnId },
    // A VERSIONLESS PURL, and the range in prose beside it.
    //
    // The first version of this put the range in the purl's version position —
    // `pkg:npm/jquery@>=3.0.0 <3.4.0` — which reads well and is wrong twice
    // over: `@id` is declared `format: iri`, and a space and angle brackets
    // make that string neither a valid IRI nor a purl any consumer can resolve.
    // OpenVEX simply has no version-range field; the spec's answer is a product
    // identity plus a status note, so that is what this emits. It survived a
    // first review because this repository's validator treats `format` as the
    // annotation the specification says it is — worth knowing when reading the
    // green from those schema tests.
    products: [{ '@id': product, identifiers: { purl: product } }],
    status: statement.status,
    timestamp: statement.createdAt.toISOString(),
    ...(statement.justification ? { justification: statement.justification } : {}),
    status_notes: coveredVersions(statement),
    ...(statement.status === 'affected'
      ? {
          // Required by the schema when the status is `affected`. The author's
          // own note is preferred; the fallback is honest about being a
          // placeholder rather than inventing a remediation nobody chose.
          action_statement:
            statement.statusNotes ??
            'Confirmed affected; remediation has not been recorded on this statement.',
          action_statement_timestamp: statement.createdAt.toISOString(),
        }
      : {}),
  };
}

/**
 * The sentence that carries what the purl no longer can.
 *
 * ALWAYS EMITTED, even with no author note: a statement whose covered range is
 * invisible reads as covering every version, which is the widest claim in the
 * system and the one nobody should make by accident.
 */
function coveredVersions(statement: VexStatementRecord): string {
  const range =
    statement.versionRange === '*'
      ? 'Applies to every version of this component.'
      : `Applies to versions ${statement.versionRange}; outside that range this component has not been assessed.`;
  return statement.statusNotes ? `${statement.statusNotes} ${range}` : range;
}
