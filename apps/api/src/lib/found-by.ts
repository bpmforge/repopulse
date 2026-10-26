import { parseExternalScannerKey } from '@repopulse/security';

/**
 * Who raised a finding (W20-15, UX_TODO X-10): one of RepoPulse's own
 * rules, the customer's own model on an analysis run, or another tool whose
 * results were imported.
 *
 * Shared (W21-01) by GET /findings and the PR's "New on this PR" answer: the
 * same finding read "your AI model fixture-model" in the panel and the raw
 * scanner key `owasp_web` on the PR page, because each screen named it its own
 * way. One function on each side now: this one, and the web's foundByLabel.
 */
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

/** The columns found_by is read from (a finding joined to its scan and analysis run). */
export interface FoundByRow {
  scannerKey: string | null;
  analysisModelId: string | null;
  scanScannerVersion?: string | null;
  scanToolVersions?: Record<string, string> | null;
}

export function foundByOf(r: FoundByRow): FoundBy {
  const ext = externalOf(r);
  if (ext) return { kind: 'imported', ...ext };
  if (r.analysisModelId) return { kind: 'model', model: r.analysisModelId };
  if (r.scannerKey) {
    return { kind: 'scanner', scanner: r.scannerKey, version: r.scanScannerVersion ?? null };
  }
  return { kind: 'unknown' };
}

export function externalOf(
  r: FoundByRow,
): { tool: string; source: 'sarif' | 'code_scanning'; tool_version: string | null } | null {
  const parsed = parseExternalScannerKey(r.scannerKey);
  if (!parsed) return null;
  const version = r.scanToolVersions?.[parsed.tool];
  return {
    tool: parsed.tool,
    source: parsed.source,
    tool_version: version && version !== 'unknown' ? version : null,
  };
}
