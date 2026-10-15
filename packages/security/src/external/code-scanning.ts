import { security, type Database } from '@repopulse/shared';
import {
  ForgeHttpError,
  type ForgeCodeScanningAlert,
  type ForgeCursor,
  type ForgeProvider,
} from '@repopulse/forge';
import { ingestExternalResults, toolsWithOpenFindings, type ToolIngestSummary } from './ingest.js';
import { toolSlug } from './keys.js';
import type { ExternalResult } from './map.js';

// GitHub code-scanning alerts → findings (W18-24). READ-ONLY.
//
// PERMISSION. Listing alerts needs the GitHub App permission "Code scanning
// alerts: Read" (`security_events: read`). The App registration in
// docs/research/github-app.md requests it, but every existing installation
// has to re-approve a new permission before it applies. So this pull runs
// behind the permission's PRESENCE: GitHub answers 403 without it,
// and the pull reports `no_code_scanning_permission` instead of an error or,
// worse, an empty result set that its sweep would read as "every alert fixed".
// Nothing here asks for, or could use, a write scope.
//
// GitLab and Gitea: not supported yet. Their adapters do not declare
// `supportsCodeScanningAlerts`, and the pull says `code_scanning_not_supported`.

export const CODE_SCANNING_PULL_KEY = 'code_scanning_pull';
export const CODE_SCANNING_PULL_VERSION = 'code_scanning.v1';

/** 100 alerts a page; 50 pages is 5,000 open alerts, which is past useful. */
const DEFAULT_MAX_PAGES = 50;

export type CodeScanningSkip =
  'code_scanning_not_supported' | 'no_code_scanning_permission' | 'code_scanning_not_enabled';

export interface CodeScanningPullDeps {
  db: Database;
  provider: ForgeProvider;
  workspaceId: number;
  repoId: number;
  /** owner/name on the forge. */
  repo: string;
  maxPages?: number;
}

export interface CodeScanningPullResult {
  /** 'skipped' is a benign reason nothing was read; it is not a fault. */
  status: 'succeeded' | 'skipped';
  skipped?: CodeScanningSkip;
  /** The forge's own words when it refused, for the run row. */
  detail?: string;
  alerts: number;
  /** True when the page cap stopped the pull: findings stored, nothing swept. */
  partial: boolean;
  tools: ToolIngestSummary[];
  scanRunId: number | null;
}

const SECURITY_SEVERITY: Record<string, number> = {
  critical: 9.5,
  high: 8,
  medium: 5.5,
  low: 2,
};

/** One alert as an ExternalResult — the same mapper as a SARIF result. */
export function alertToResult(alert: ForgeCodeScanningAlert): ExternalResult {
  const level = alert.securitySeverityLevel?.toLowerCase();
  return {
    tool: alert.toolName,
    toolVersion: alert.toolVersion,
    ruleId: alert.ruleId,
    ruleTitle: alert.ruleDescription ?? alert.ruleName,
    level: alert.ruleSeverity,
    // The alert API gives the BAND, not the score; a representative point in
    // each of GitHub's bands maps back to the same 1-5 severity a SARIF
    // `security-severity` in that band would.
    securitySeverity: level && level in SECURITY_SEVERITY ? SECURITY_SEVERITY[level]! : null,
    precision: null,
    tags: alert.ruleTags,
    file: alert.path,
    lineStart: alert.startLine,
    lineEnd: alert.endLine,
    message: alert.message ?? alert.ruleDescription ?? alert.ruleId,
    // The alert number is GitHub's own identity for "this problem here",
    // stable across analyses — exactly what the dedup key wants.
    fingerprint: `alert:${alert.number}`,
  };
}

async function recordPull(
  deps: CodeScanningPullDeps,
  findingCount: number,
  partial: boolean,
  error: string | null,
): Promise<number> {
  const [row] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: CODE_SCANNING_PULL_KEY,
      scannerVersion: CODE_SCANNING_PULL_VERSION,
      commitSha: '',
      trigger: 'schedule',
      status: 'succeeded',
      partial,
      findingCount,
      error,
      startedAt: new Date(),
      finishedAt: new Date(),
    })
    .returning({ id: security.scanRuns.id });
  return row!.id;
}

/**
 * Pulls open alerts and stores them under `external:<tool>:code-scanning`.
 *
 * Skips are RETURNED (the processor writes the run row that says why); budget
 * parking and unexpected HTTP failures THROW, so the queue retries them like
 * any other forge read.
 */
export async function runCodeScanningPull(
  deps: CodeScanningPullDeps,
): Promise<CodeScanningPullResult> {
  const empty = { alerts: 0, partial: false, tools: [], scanRunId: null };
  const list = deps.provider.listCodeScanningAlerts?.bind(deps.provider);
  if (!deps.provider.capabilities.supportsCodeScanningAlerts || !list) {
    return { status: 'skipped', skipped: 'code_scanning_not_supported', ...empty };
  }

  const alerts: ForgeCodeScanningAlert[] = [];
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  let cursor: ForgeCursor | undefined;
  let pages = 0;
  let partial = false;
  try {
    do {
      const page = await list({ lane: 'scan', repoId: String(deps.repoId) }, deps.repo, cursor);
      alerts.push(...page.items.filter((a) => a.state === 'open'));
      cursor = page.nextCursor;
      pages += 1;
      if (cursor && pages >= maxPages) {
        partial = true;
        break;
      }
    } while (cursor);
  } catch (err) {
    if (err instanceof ForgeHttpError && err.status === 403) {
      return {
        status: 'skipped',
        skipped: 'no_code_scanning_permission',
        ...(err.detail ? { detail: err.detail } : {}),
        ...empty,
      };
    }
    if (err instanceof ForgeHttpError && err.status === 404) {
      return {
        status: 'skipped',
        skipped: 'code_scanning_not_enabled',
        ...(err.detail ? { detail: err.detail } : {}),
        ...empty,
      };
    }
    throw err;
  }

  const results = alerts.map(alertToResult);
  // Tools that had alerts last time and have none now: all fixed or
  // dismissed on GitHub. Swept like any tool, but only after a COMPLETE pull.
  const sweepAbsentTools = partial
    ? []
    : (await toolsWithOpenFindings(deps.db, deps.workspaceId, deps.repoId, 'code_scanning')).filter(
        (t) => !results.some((r) => toolSlug(r.tool) === t),
      );

  const tools = await ingestExternalResults({
    db: deps.db,
    workspaceId: deps.workspaceId,
    repoId: deps.repoId,
    source: 'code_scanning',
    results,
    commitSha: '',
    trigger: 'schedule',
    sweep: !partial,
    sweepAbsentTools,
  });

  const stored = tools.reduce((n, t) => n + t.results - t.supersededByPack.length, 0);
  const scanRunId = await recordPull(
    deps,
    stored,
    partial,
    partial
      ? `Stopped after ${maxPages} pages of alerts; stored what was read and closed nothing.`
      : null,
  );
  return { status: 'succeeded', alerts: alerts.length, partial, tools, scanRunId };
}
