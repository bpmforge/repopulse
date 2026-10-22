import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { read, security, type Database } from '@repopulse/shared';
import {
  ForgeHttpError,
  type ForgeCodeScanningAlert,
  type ForgeCodeScanningState,
  type ForgeCursor,
  type ForgeProvider,
} from '@repopulse/forge';
import { dedupKey } from '@repopulse/insights';
import { ingestExternalResults, toolsWithOpenFindings, type ToolIngestSummary } from './ingest.js';
import { toolSlug } from './keys.js';
import { toIncomingFinding, type ExternalResult } from './map.js';

// GitHub code-scanning alerts → findings (W18-24). READ-ONLY. Since W20-25
// (UX_TODO FND-63) dismissed and fixed alerts are read too, and their state is
// copied onto our findings; nothing is ever written back to GitHub.
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

/**
 * W20-25 (UX_TODO FND-63): dismissed and fixed alerts are read most recently
 * updated first, 5 pages (500) of each per pull. Closed alerts only grow, and
 * what matters is the decisions made since the last pull, which are at the
 * front; an older decision was applied by an earlier pull.
 */
const CLOSED_MAX_PAGES = 5;

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
  /** Pages of dismissed and of fixed alerts read per pull (W20-25). */
  closedMaxPages?: number;
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
  /** W20-25 (FND-63): our findings closed because GitHub dismissed or fixed the alert. */
  githubDismissed?: number;
  githubFixed?: number;
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

/**
 * GitHub's dismissal reason as one of ours. Only a false positive counts as
 * one (it feeds the rule's false-positive rate); "won't fix", "used in tests"
 * and "mitigated" are not-applicable here. GitHub's own words go in the
 * history, so nothing is lost by the mapping.
 */
export function dismissReasonFromGithub(reason: string | null | undefined): string {
  return reason?.toLowerCase() === 'false positive' ? 'false_positive' : 'not_applicable';
}

/** "dismissed on GitHub by ada: false positive (only in fixtures)". */
export function githubDismissalText(alert: ForgeCodeScanningAlert): string {
  const by = alert.dismissedBy ? ` by ${alert.dismissedBy}` : '';
  const why = alert.dismissedReason ? `: ${alert.dismissedReason}` : '';
  const comment = alert.dismissedComment?.replace(/\s+/g, ' ').trim();
  const note = comment ? ` (${comment.length > 200 ? `${comment.slice(0, 199)}…` : comment})` : '';
  return `dismissed on GitHub${by}${why}${note}`;
}

/** The dedup key our store gave this alert's finding: the same mapper, the same key. */
function keyOf(alert: ForgeCodeScanningAlert): string {
  const f = toIncomingFinding(alertToResult(alert), 'code_scanning');
  return dedupKey({
    dimension: f.dimension,
    file: f.file,
    evidenceQuote: f.evidenceQuote,
    lineStart: f.lineStart,
    scannerKey: f.scannerKey ?? null,
    ruleId: f.ruleId ?? null,
    fingerprint: f.fingerprint ?? null,
  });
}

/**
 * Copies GitHub's dismissed and fixed state onto our findings (W20-25, UX_TODO
 * FND-63). READ-ONLY on GitHub: nothing is sent back.
 *
 * Dismissed on GitHub: an open or confirmed finding becomes dismissed, and one
 * an earlier pull had resolved automatically (the alert simply left the open
 * list, which read as a fix) is corrected to dismissed. Fixed on GitHub: an
 * open or confirmed finding becomes resolved. A person's decision here is
 * never overridden, and an alert reopened on GitHub does not reopen a finding
 * someone dismissed here (lifecycle: a human decision is never undone by a
 * machine). Each change writes a history row with no actor (automatic) and
 * GitHub's own words as the reason.
 */
export async function applyGithubAlertStates(
  db: Database,
  workspaceId: number,
  repoId: number,
  alerts: readonly ForgeCodeScanningAlert[],
): Promise<{ dismissed: number; fixed: number }> {
  let dismissed = 0;
  let fixed = 0;
  const byKey = new Map<string, ForgeCodeScanningAlert>();
  for (const a of alerts) {
    if (a.state === 'dismissed' || a.state === 'fixed') byKey.set(keyOf(a), a);
  }
  const keys = [...byKey.keys()];
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const rows = await db
      .select({
        id: read.findings.id,
        status: read.findings.status,
        dedupKey: read.findings.dedupKey,
      })
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, workspaceId),
          eq(read.findings.repoId, repoId),
          inArray(read.findings.dedupKey, chunk),
          or(
            inArray(read.findings.status, ['open', 'confirmed']),
            // Resolved by a machine, never by a person, and not a rotation.
            and(
              eq(read.findings.status, 'resolved'),
              isNull(read.findings.statusChangedBy),
              isNull(read.findings.dismissReason),
            ),
          ),
        ),
      );
    for (const row of rows) {
      const alert = byKey.get(row.dedupKey)!;
      const now = new Date();
      if (alert.state === 'dismissed') {
        await db
          .update(read.findings)
          .set({
            status: 'dismissed',
            dismissReason: dismissReasonFromGithub(alert.dismissedReason),
            statusChangedAt: now,
          })
          .where(and(eq(read.findings.id, row.id), eq(read.findings.workspaceId, workspaceId)));
        await db.insert(read.findingEvents).values({
          workspaceId,
          findingId: row.id,
          fromStatus: row.status,
          toStatus: 'dismissed',
          actor: null,
          reason: githubDismissalText(alert),
        });
        dismissed += 1;
      } else if (row.status !== 'resolved') {
        await db
          .update(read.findings)
          .set({ status: 'resolved', statusChangedAt: now })
          .where(and(eq(read.findings.id, row.id), eq(read.findings.workspaceId, workspaceId)));
        await db.insert(read.findingEvents).values({
          workspaceId,
          findingId: row.id,
          fromStatus: row.status,
          toStatus: 'resolved',
          actor: null,
          reason: `fixed on GitHub${alert.fixedAt ? ` (${alert.fixedAt.slice(0, 10)})` : ''}`,
        });
        fixed += 1;
      }
    }
  }
  return { dismissed, fixed };
}

/** Recently closed alerts of one state, newest decisions first. Never throws for a refusal. */
async function listClosed(
  deps: CodeScanningPullDeps,
  list: NonNullable<ForgeProvider['listCodeScanningAlerts']>,
  state: ForgeCodeScanningState,
): Promise<ForgeCodeScanningAlert[]> {
  const out: ForgeCodeScanningAlert[] = [];
  let cursor: ForgeCursor | undefined;
  let pages = 0;
  try {
    do {
      const page = await list({ lane: 'scan', repoId: String(deps.repoId) }, deps.repo, cursor, {
        state,
      });
      out.push(...page.items.filter((a) => a.state === state));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < (deps.closedMaxPages ?? CLOSED_MAX_PAGES));
  } catch (err) {
    // The open listing already worked, so a refusal here is not a permission
    // story worth failing the pull for: the sweep still closes what left.
    if (err instanceof ForgeHttpError) return out;
    throw err;
  }
  return out;
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

  // W20-25 (UX_TODO FND-63): GitHub's dismissed and fixed alerts, applied
  // BEFORE the sweep, so a dismissal reads as one rather than as a fix.
  const closed = [
    ...(await listClosed(deps, list, 'dismissed')),
    ...(await listClosed(deps, list, 'fixed')),
  ];
  const applied = await applyGithubAlertStates(deps.db, deps.workspaceId, deps.repoId, closed);

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
  return {
    status: 'succeeded',
    alerts: alerts.length,
    partial,
    tools,
    scanRunId,
    githubDismissed: applied.dismissed,
    githubFixed: applied.fixed,
  };
}
