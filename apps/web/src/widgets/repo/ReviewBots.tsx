import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { RatioParts, RepoReviewBots } from './contracts.js';

// AI Reviewers tab (W18-23, METRICS.md §5): what the review bots a team
// already runs actually do on its pull requests.
//
// Tools, not people (N-9). Rows are TOOLS, in the API's fixed order — never
// sorted by a number, because a sorted table of tools is a leaderboard by
// another name. No colour says good or bad: a high "followed by a code change"
// share can mean useful feedback or a noisy bot whose nits got fixed to make
// it stop, and only the team can tell which.
//
// Every blank cell says why it is blank. "This forge does not give us line
// anchors", "the token was refused" and "not fetched yet" are three different
// facts, and none of them is zero.

interface Props {
  repoId: string;
  window: string;
}

const FORGE_NAMES: Record<string, string> = { github: 'GitHub', gitea: 'Gitea', gitlab: 'GitLab' };

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** "35 of 85 (41%)" — the parts first, so nobody reads a percentage of four. */
export function formatShare(r: RatioParts | null): string {
  if (r === null || r.value === null) return '—';
  return `${r.numerator} of ${r.denominator} (${pct(r.value)})`;
}

export function formatPerPr(r: RatioParts | null): string {
  if (r === null || r.value === null) return '—';
  return r.value.toFixed(1);
}

/** Minutes under an hour, hours under two days, days beyond. */
export function formatHours(h: number | null): string {
  if (h === null) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

/** The sentence under the table that says why comment-based columns are blank. */
export function lineDataNote(data: RepoReviewBots): string | null {
  const forge = data.forge ? (FORGE_NAMES[data.forge] ?? data.forge) : 'This forge';
  if (data.line_data === 'refused') {
    return `${forge} refused the review-comment request for this repository, so comments per PR, the code-change share and repeat-after-dismiss are blank. Settings → Sync shows the error.`;
  }
  if (data.line_data === 'not_collected') {
    if (data.forge !== null && data.forge !== 'github') {
      return `${forge} does not give RepoPulse line-level review-comment data, so comments per PR, the code-change share and repeat-after-dismiss are not available for this repository. Reviews per PR and time to first comment are.`;
    }
    return 'No line-level review-comment data has been collected for this window’s pull requests yet: comments are fetched when a pull request is ingested, and pull requests ingested before this measurement existed have none. Comment-based columns stay blank rather than read as zero.';
  }
  if (data.prs_with_line_data < data.prs_in_window) {
    return `Line-level comment data covers ${data.prs_with_line_data} of ${data.prs_in_window} pull requests in this window; comment-based columns are measured on those only.`;
  }
  return null;
}

const UNAVAILABLE = 'Needs line-level review-comment data — see the note below the table';

/**
 * Why a cell is a dash. Two different facts: the data is missing entirely
 * (null), or it is there and nothing qualified (an empty denominator).
 */
function blankReason(r: RatioParts | null, empty: string): string | null {
  if (r === null) return UNAVAILABLE;
  if (r.value === null) return empty;
  return null;
}

/**
 * W20-11 (UX_TODO AI-47): the reasons for blank cells lived only in `title`
 * tooltips, which keyboard, touch and screen-reader users never get. Each blank
 * now carries a visible footnote number (and its words for a screen reader),
 * and the notes are listed under the table.
 */
function footnotes() {
  const notes: string[] = [];
  const mark = (reason: string | null) => {
    if (reason === null) return null;
    let n = notes.indexOf(reason) + 1;
    if (n === 0) n = notes.push(reason);
    return (
      <>
        <sup aria-hidden="true" className="ml-0.5 text-fg-muted">
          {n}
        </sup>
        <span className="sr-only"> ({reason})</span>
      </>
    );
  };
  return { notes, mark };
}

export function ReviewBots({ repoId, window }: Props) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<RepoReviewBots>({
    endpoint: '/repos/{id}/review-bots',
    path: { id: repoId },
    query: { window },
  });

  const bots = data?.bots ?? [];
  const state = frameState({
    isLoading,
    isError,
    isEmpty: data !== undefined && bots.length === 0,
  });
  const note = data ? lineDataNote(data) : null;
  const { notes, mark } = footnotes();

  return (
    <div className="flex flex-col gap-4" data-testid="review-bots-tab">
      <p className="max-w-3xl text-sm text-fg-muted">
        What the AI review tools on this repository do on its pull requests. This compares tools,
        not people. Signals, not grades: no number here is better for being higher or lower, and
        none of it counts toward review coverage, cycle time or review load, which measure human
        review only.
      </p>
      {/* W20-11 (UX_TODO AI-15): people looking for RepoPulse's own AI review
          landed here, on third-party bots. */}
      <p className="max-w-3xl text-sm text-fg-muted" data-testid="review-bots-own-ai">
        Looking for RepoPulse&rsquo;s own AI review of this repository? It is on the{' '}
        <Link
          to="/repos/$repoId/ai-review"
          params={{ repoId } as never}
          hash="ai-review-pass"
          className="text-fg underline underline-offset-2"
        >
          AI review tab
        </Link>
        .
      </p>

      <WidgetFrame
        title="AI reviewers"
        state={state}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage={
          data
            ? `None of the AI review tools RepoPulse recognises (CodeRabbit, Copilot code review, Qodo Merge, Greptile, Cursor BugBot) reviewed a pull request opened in the last ${window}.`
            : 'No AI reviewer activity in this window.'
        }
        testId="review-bots"
      >
        <div className="flex flex-col gap-3">
          {/* W20-11 (UX_TODO AI-47): it scrolls sideways at phone width, so the
              region takes keyboard focus and has a name. */}
          <div
            className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            tabIndex={0}
            role="region"
            aria-label="AI review tools, scrolls sideways"
          >
            <table className="w-full min-w-[720px] text-sm" data-testid="review-bots-table">
              <caption className="sr-only">
                AI review tools on pull requests opened in the last {window}, one row per tool
              </caption>
              <thead>
                <tr className="text-left text-xs text-fg-muted">
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Tool
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    PRs reviewed
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    Reviews / PR
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    Comments / PR
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    Time to first comment
                    <span className="block font-normal">median · p90</span>
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    Followed by a code change
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Repeat after dismiss
                  </th>
                </tr>
              </thead>
              <tbody>
                {bots.map((b) => (
                  <tr
                    key={b.key}
                    className="border-t border-border align-top"
                    data-testid={`review-bot-${b.key}`}
                  >
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      <span className="font-medium text-fg">{b.name}</span>
                      <span className="block text-xs text-fg-faint">
                        {b.logins_seen.join(', ')}
                      </span>
                    </th>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatShare(b.reach)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatPerPr(b.reviews_per_pr)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatPerPr(b.comments_per_pr)}
                      {mark(
                        blankReason(
                          b.comments_per_pr,
                          'No reviewed pull request had line-level data',
                        ),
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatHours(b.time_to_first.median_hours)} ·{' '}
                      {formatHours(b.time_to_first.p90_hours)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatShare(b.followed_by_change)}
                      {mark(
                        blankReason(
                          b.followed_by_change,
                          'No line comments on closed or merged pull requests yet',
                        ),
                      )}
                      {b.followed_by_change !== null && b.followed_by_change.pending > 0 && (
                        <span className="block text-xs text-fg-faint">
                          {b.followed_by_change.pending} on open PRs, not counted yet
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatShare(b.repeat_after_dismiss)}
                      {mark(
                        blankReason(
                          b.repeat_after_dismiss,
                          'None of this tool’s reviews with inline comments was dismissed',
                        ),
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {notes.length > 0 ? (
            <ol className="text-xs text-fg-muted" data-testid="review-bots-blank-notes">
              {notes.map((n, i) => (
                <li key={n}>
                  <sup aria-hidden="true">{i + 1}</sup> Blank because: {n}.
                </li>
              ))}
            </ol>
          ) : null}

          {note && (
            <p className="text-xs text-fg-muted" data-testid="review-bots-line-data">
              {note}
            </p>
          )}
          {data && data.other_bot_reviews > 0 && (
            <p className="text-xs text-fg-muted" data-testid="review-bots-other">
              {data.other_bot_reviews} review(s) by other bot accounts are not attributed to a tool
              here.
            </p>
          )}
        </div>
      </WidgetFrame>

      <section
        className="rounded-md border border-border p-4 text-sm"
        aria-labelledby="review-bots-definitions"
        data-testid="review-bots-definitions"
      >
        <h2 id="review-bots-definitions" className="mb-2 font-medium">
          How these are measured
        </h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-fg-muted md:grid-cols-[max-content_1fr]">
          <dt className="font-medium text-fg">Which pull requests</dt>
          <dd>
            Pull requests opened in the last {window}, excluding ones a bot opened. A tool is
            matched by its exact account name.
          </dd>
          <dt className="font-medium text-fg">PRs reviewed</dt>
          <dd>Pull requests with at least one review or inline comment from the tool.</dd>
          <dt className="font-medium text-fg">Comments / PR</dt>
          <dd>New inline comments (replies inside a thread are not counted) per reviewed PR.</dd>
          <dt className="font-medium text-fg">Time to first comment</dt>
          <dd>
            From the pull request opening to the tool’s first review or inline comment on it. Draft
            time is included.
          </dd>
          <dt className="font-medium text-fg">Followed by a code change</dt>
          <dd>
            Of the tool’s new inline comments on specific lines, the share whose lines a later push
            changed — the forge stopped anchoring the comment to the pull request’s final diff
            (GitHub shows these as “Outdated”). Counted only once the pull request is closed or
            merged. A rebase that moves the lines can count too; a fix made somewhere else does not.
          </dd>
          <dt className="font-medium text-fg">Repeat after dismiss</dt>
          <dd>
            Of the tool’s dismissed reviews that had inline comments, the share after which the tool
            commented on one of the same files of the same pull request again. The forge does not
            say when a review was dismissed, so “after” is measured from when the review was posted.
          </dd>
        </dl>
      </section>
    </div>
  );
}
