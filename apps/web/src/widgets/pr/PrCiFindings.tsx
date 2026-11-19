import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { foundByLabel, locationOf, type FoundBy } from '../findings/contracts.js';
import { FindingSeverityBadge } from '../findings/FindingSeverity.js';

// "New on this PR" (W20-15, UX_TODO X-15).
//
// The panel asked /findings?pr_number=, which matches only findings stamped
// with the PR's id. It left out the Semgrep incremental findings the CI answer
// counts through the PR's scan runs, still listed findings a later push had
// fixed, plus dismissed and shadow-rule ones, and never said whether the head
// had been scanned. So the finding that failed a developer's build could be
// missing here, and findings that no longer applied could appear. It now reads
// the same answer `repopulse check` reads.

export interface PrCiFinding {
  id: number;
  rule_id: string | null;
  scanner_key: string | null;
  dimension: string;
  severity: number;
  title: string;
  file: string | null;
  line_start: number | null;
  line_end: number | null;
  status: string;
  introduced_by_pr: boolean;
  seen_at_head: boolean;
  /** W27-36: absent from an older API. */
  verify_status?: string;
  ai_review?: boolean;
  /** W21-01: absent from an older API, which then falls back to the key. */
  found_by?: FoundBy;
}

export interface PrCiFindings {
  pull: { number: number; head_sha: string };
  head: {
    sha: string;
    scanned: boolean;
    scanners: { scanner_key: string; scanned_at: string }[];
    pending?: string[];
    failed?: string[];
  };
  items: PrCiFinding[];
  next_cursor: string | null;
}

/** The head line: which commit, and which scanners have (and have not) read it. */
export function headSummary(head: PrCiFindings['head']): string {
  // A real commit id is abbreviated the usual way; anything else (a fixture's
  // `payments-pr4-head`) is shown whole, because cutting it at 7 characters
  // printed "Head payment" — a word, not a commit (W21-01).
  const sha = /^[0-9a-f]{7,}$/i.test(head.sha) ? head.sha.slice(0, 7) : head.sha;
  const by = head.scanners.map((s) => s.scanner_key);
  const parts = [
    by.length > 0
      ? `Head commit ${sha} scanned by ${by.join(', ')}.`
      : `Head commit ${sha} not scanned yet.`,
  ];
  if (head.pending && head.pending.length > 0) {
    parts.push(`Still scanning: ${head.pending.join(', ')}.`);
  }
  if (head.failed && head.failed.length > 0) {
    parts.push(`Failed at this head: ${head.failed.join(', ')}.`);
  }
  return parts.join(' ');
}

/**
 * W27-36: several review areas often report the same line (on the M4 demo, 28
 * AI notes for about 10 problems). Unconfirmed AI notes on the same file and
 * line fold into the first one, which is the most severe (the API sorts by
 * severity); the row says how many more there are. Scanner findings and
 * confirmed AI findings are never folded: each of those counts in CI.
 */
export function foldAiNotes<
  T extends {
    file: string | null;
    line_start: number | null;
    ai_review?: boolean;
    verify_status?: string;
  },
>(items: readonly T[]): { item: T; more: number }[] {
  const out: { item: T; more: number }[] = [];
  const at = new Map<string, { item: T; more: number }>();
  for (const item of items) {
    const foldable =
      item.ai_review === true && item.verify_status !== 'confirmed' && item.file !== null;
    if (!foldable) {
      out.push({ item, more: 0 });
      continue;
    }
    const key = `${item.file}:${item.line_start ?? 0}`;
    const first = at.get(key);
    if (first) {
      first.more += 1;
      continue;
    }
    const row = { item, more: 0 };
    at.set(key, row);
    out.push(row);
  }
  return out;
}

export function PrCiFindingsPanel({ repoId, number }: { repoId: string; number: string }) {
  const [includePreexisting, setIncludePreexisting] = useState(false);
  const { data, isLoading, isError, error, refetch } = useApiQuery<PrCiFindings>({
    endpoint: '/repos/{id}/pulls/{number}/findings',
    path: { id: repoId, number },
    // W27-36: the page also lists AI review findings no second model has
    // confirmed, labelled; a CI check leaves those out.
    query: { new: includePreexisting ? 'false' : 'true', include_unconfirmed_ai: 'true' },
  });
  const items = data?.items ?? [];
  const rows = foldAiNotes(items);

  return (
    <WidgetFrame
      title="New on this PR"
      state={frameState({
        isLoading,
        isError,
        isEmpty: false,
      })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
    >
      <div className="flex flex-col gap-2" data-testid="pr-ci-findings">
        {data && (
          <p
            className={`text-xs ${data.head.scanned ? 'text-fg-muted' : 'text-warn'}`}
            data-testid="pr-ci-head"
          >
            {headSummary(data.head)}
            {!data.head.scanned &&
              ' Findings below may be from earlier commits of this PR; a CI check would wait.'}
          </p>
        )}
        {rows.some(({ item }) => item.ai_review && item.verify_status !== 'confirmed') && (
          <p className="text-xs text-fg-muted" data-testid="pr-ci-ai-note">
            Rows marked &quot;not in CI&quot; come from an AI review that no second model has
            confirmed. They are shown here and do not fail a CI check.
          </p>
        )}
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={includePreexisting}
            onChange={(e) => setIncludePreexisting(e.target.checked)}
            data-testid="pr-ci-preexisting"
          />
          Include pre-existing findings in touched files
        </label>
        {data && items.length === 0 ? (
          <p className="text-sm text-fg-muted" data-testid="pr-ci-empty">
            {includePreexisting
              ? 'No open findings on this PR or in the files it touches.'
              : 'No new findings on this PR.'}
          </p>
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Findings on this pull request"
          >
            <table
              className="table-plain w-full min-w-[40rem] text-sm"
              data-testid="pr-automated-review"
            >
              <caption className="sr-only">Findings on this pull request</caption>
              <thead>
                <tr className="text-left text-xs text-fg-muted">
                  <th scope="col">Severity</th>
                  <th scope="col">Finding</th>
                  <th scope="col">File</th>
                  <th scope="col">Found by</th>
                  <th scope="col">On the head</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ item: f, more }) => (
                  <tr key={f.id} className="border-t border-border" data-testid="pr-ci-row">
                    <td className="py-1 whitespace-nowrap">
                      <FindingSeverityBadge severity={f.severity} />
                    </td>
                    <th scope="row" className="py-1 text-left font-normal">
                      <Link
                        to="/repos/$repoId/findings"
                        params={{ repoId }}
                        search={(prev: Record<string, unknown>) => ({ ...prev, finding: f.id })}
                        className="text-accent hover:underline"
                      >
                        {f.title}
                      </Link>
                      {!f.introduced_by_pr && (
                        <span className="ml-1 text-xs text-fg-muted">(pre-existing)</span>
                      )}
                      {more > 0 && (
                        <span className="ml-1 text-xs text-fg-muted" data-testid="pr-ci-ai-more">
                          (+{more} more AI {more === 1 ? 'note' : 'notes'} on this line)
                        </span>
                      )}
                    </th>
                    <td className="py-1 font-mono text-xs">
                      {locationOf({ file: f.file, line_range: [f.line_start, f.line_end] })}
                    </td>
                    <td className="py-1 text-xs" data-testid="pr-ci-found-by">
                      {foundByLabel(f.found_by, f.rule_id) ??
                        f.rule_id ??
                        f.scanner_key ??
                        f.dimension}
                      {f.ai_review && f.verify_status !== 'confirmed' && (
                        <span
                          className="ml-1 rounded border border-border px-1 whitespace-nowrap text-fg-muted"
                          title="An AI review raised this and no second model has confirmed it, so a CI check does not count it."
                          data-testid="pr-ci-ai-uncounted"
                        >
                          not in CI
                        </span>
                      )}
                    </td>
                    <td className="py-1 text-xs whitespace-nowrap">
                      {f.seen_at_head ? 'yes' : 'not checked yet'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.next_cursor && (
          <p className="text-xs text-fg-muted">
            Showing the first {items.length}. The rest are in the repository&apos;s Findings tab.
          </p>
        )}
      </div>
    </WidgetFrame>
  );
}
