import type { Database } from '@repopulse/shared';
import { extractSarifResults, parseSarif, type SarifExtraction } from './sarif.js';
import { ingestExternalResults, type ToolIngestSummary } from './ingest.js';

// SARIF upload → findings (W18-24). The API route is a thin shell over this so
// the whole path — validate, normalise, dedupe, persist, sweep — is testable
// without HTTP.

const SHA = /^[0-9a-f]{7,40}$/i;

export interface SarifUploadParams {
  db: Database;
  workspaceId: number;
  repoId: number;
  /** Parsed JSON body. Untrusted. */
  document: unknown;
  /** Caller-supplied commit; wins over the SARIF's own versionControlProvenance. */
  commitSha?: string | null;
  /** See ExternalIngestParams.sweep. Defaults to true: an upload is the tool's full result. */
  sweep?: boolean;
  /**
   * Absolute checkout path the tool ran in, for tools that write absolute
   * file URIs and no originalUriBaseIds. GitHub Actions paths need none.
   */
  sourceRoot?: string | null;
}

export type SarifUploadResult =
  | {
      ok: true;
      commitSha: string;
      tools: ToolIngestSummary[];
      results: number;
      skipped: SarifExtraction['skipped'];
    }
  | { ok: false; errors: { path: string; message: string }[] };

export async function ingestSarifUpload(params: SarifUploadParams): Promise<SarifUploadResult> {
  const parsed = parseSarif(params.document);
  if (!parsed.ok) return parsed;

  const extraction = extractSarifResults(parsed.log, {
    ...(params.sourceRoot ? { sourceRoots: [params.sourceRoot] } : {}),
  });
  // A commit we cannot vouch for is stored as '' rather than as whatever
  // string arrived: the forge link builds a URL from it, and a garbage ref is
  // a 404 that looks like a RepoPulse bug.
  const candidate = params.commitSha ?? extraction.revisionId ?? '';
  const commitSha = SHA.test(candidate) ? candidate.toLowerCase() : '';

  const tools = await ingestExternalResults({
    db: params.db,
    workspaceId: params.workspaceId,
    repoId: params.repoId,
    source: 'sarif',
    results: extraction.results,
    commitSha,
    trigger: 'manual',
    sweep: params.sweep ?? true,
  });
  return {
    ok: true,
    commitSha,
    tools,
    results: extraction.results.length,
    skipped: extraction.skipped,
  };
}
