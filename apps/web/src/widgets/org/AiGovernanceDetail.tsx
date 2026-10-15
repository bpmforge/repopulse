import { Link } from '@tanstack/react-router';
import { WINDOW_PRESETS } from '@repopulse/shared/url-state';
import { SectionHeader, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { AiGovernance, AiGovernanceMeasure, MeContext } from './contracts.js';

// The AI-code governance screen (W18-29, over W18-20's comparison).
//
// The org tile answers "is anything different?" in two numbers and a table;
// this screen is where someone goes to find out how much to trust that answer.
// So it shows what the tile has no room for: who wrote the changes INCLUDING
// the cohorts left out (automation, commits ingested before authorship was
// recorded), each measure's basis and sample size in plain text rather than a
// hover title a phone cannot reach, and how classification works.
//
// SIGNALS, NOT GRADES (N-9). It renders the server's comparison and decides
// nothing. No colour says good or bad, no score, no ranking, no person: the
// endpoint is aggregate-only and ignores the person filter on purpose.

interface Props {
  window: string;
  search: Record<string, string>;
}

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const share = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(0)}%`;

function value(m: AiGovernanceMeasure, v: number | null): string {
  if (v === null) return '—';
  return m.unit === 'ratio' ? pct(v) : v.toFixed(2);
}

/** The signal column's words. Direction is about AI relative to human, never a verdict. */
export function signalWords(m: AiGovernanceMeasure): string {
  if (m.note?.startsWith('Not measured')) return 'not measured';
  if (!m.comparable || m.direction === null) return 'too small to compare';
  return m.direction === 'similar' ? 'similar' : `${m.direction} for AI`;
}

function isPreset(window: string): boolean {
  return (WINDOW_PRESETS as readonly string[]).includes(window);
}

export function AiGovernanceDetail({ window, search }: Props) {
  const preset = isPreset(window);
  const { data, isLoading, isError, error, refetch } = useApiQuery<AiGovernance>(
    {
      endpoint: '/org/ai-governance',
      // `person` is deliberately NOT forwarded: the endpoint is aggregate-only.
      query: { window, ...(search.repos ? { repos: search.repos } : {}) },
    },
    { enabled: preset },
  );
  const { data: me } = useApiQuery<MeContext>({ endpoint: '/me/context' });

  // UNAVAILABLE, said as such (not as an error): the comparison is computed
  // over a preset window, and a custom range is a question it cannot answer.
  if (!preset) {
    return (
      <WidgetFrame
        title="AI-authored vs human changes"
        state="empty"
        testId="governance-unavailable"
        emptyMessage="This comparison is computed over a preset window — 7, 30, 90 or 365 days — so it cannot answer for a custom date range. Pick a preset window in the filter bar."
      />
    );
  }

  const classified = data ? data.counts.aiCommits + data.counts.humanCommits : 0;
  const ingested = data
    ? classified + data.counts.automationCommits + data.counts.unknownCommits
    : 0;
  // Two different blanks, two different sentences: nothing happened in the
  // window, versus things happened that predate the signals this reads.
  const unclassifiable = data !== undefined && classified === 0 && data.counts.unknownCommits > 0;
  const state = frameState({ isLoading, isError, isEmpty: data !== undefined && classified === 0 });

  const emptyMessage = unclassifiable
    ? `Authorship could not be classified for any change in this window: all ${data.counts.unknownCommits} commits were ingested before Repo Pulse recorded co-author trailers and branch names. Commits synced from now on carry them.`
    : 'No commits in this window across the selected repositories, so there is nothing to compare. Try a longer window or a different repository filter.';

  return (
    <div className="flex flex-col gap-4" data-testid="governance">
      <WidgetFrame
        title="Who wrote the changes"
        state={state}
        onRetry={() => void refetch()}
        {...(error ? { errorMessage: error.message, error } : {})}
        emptyMessage={emptyMessage}
        testId={unclassifiable ? 'governance-unclassifiable' : 'governance-cohorts'}
      >
        {data && classified > 0 && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="overflow-x-auto">
              <table className="table-plain w-full text-sm" data-testid="governance-cohort-table">
                <caption className="sr-only">Changes in this window by authorship</caption>
                <thead>
                  <tr className="text-left text-xs text-fg-muted">
                    <th scope="col">Changes</th>
                    <th scope="col" className="text-right">
                      AI
                    </th>
                    <th scope="col" className="text-right">
                      Human
                    </th>
                    <th scope="col" className="text-right">
                      Left out
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-border" data-testid="cohort-commits">
                    <th scope="row" className="py-1 text-left font-normal">
                      Commits
                    </th>
                    <td className="py-1 text-right tabular-nums">
                      {data.counts.aiCommits}{' '}
                      <span className="text-xs text-fg-muted">({pct(data.aiShareCommits)})</span>
                    </td>
                    <td className="py-1 text-right tabular-nums">{data.counts.humanCommits}</td>
                    <td className="py-1 text-right tabular-nums">
                      {data.counts.automationCommits + data.counts.unknownCommits}
                    </td>
                  </tr>
                  <tr className="border-t border-border" data-testid="cohort-prs">
                    <th scope="row" className="py-1 text-left font-normal">
                      Pull requests
                    </th>
                    <td className="py-1 text-right tabular-nums">
                      {data.counts.aiPrs}{' '}
                      <span className="text-xs text-fg-muted">({pct(data.aiSharePrs)})</span>
                    </td>
                    <td className="py-1 text-right tabular-nums">{data.counts.humanPrs}</td>
                    <td className="py-1 text-right tabular-nums">
                      {data.counts.automationPrs + data.counts.unknownPrs}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-fg-muted" data-testid="governance-left-out">
              Left out of every comparison: {data.counts.automationCommits} commits by automation
              (dependency bots and the like) and {data.counts.unknownCommits} ingested before
              authorship signals were recorded
              {ingested > 0 ? ` — ${share(classified, ingested)} of commits are classified` : ''}.
              The share is of classified changes only.
            </p>
          </div>
        )}
      </WidgetFrame>

      {data && classified > 0 && (
        <WidgetFrame
          title="AI-authored compared with human"
          state="ready"
          testId="governance-measures"
        >
          <div className="flex flex-col gap-3 text-sm">
            {!data.anyComparable && (
              <p className="text-xs text-fg" role="note" data-testid="governance-small-sample">
                No measure has a big enough sample in this window to compare the two. Each row says
                what it needs; a longer window usually gets there.
              </p>
            )}
            {/* A list, not a four-column table (W18-29): at 390px the table
                scrolled inside its frame and hid the Signal column, which is
                the one word the row exists to say. */}
            <ul
              className="flex flex-col"
              aria-label="Each measure for AI-authored and human changes, with the sample it rests on"
            >
              {data.measures.map((m) => (
                <li
                  key={m.key}
                  className="flex flex-col gap-1 border-t border-border py-2 first:border-t-0"
                  data-testid={`governance-measure-${m.key}`}
                  data-comparable={m.comparable ? 'true' : 'false'}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <h3 className="text-sm font-normal text-fg">{m.label}</h3>
                    <span className="text-xs text-fg-muted">{signalWords(m)}</span>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 sm:w-96">
                    <div>
                      <dt className="text-xs text-fg-muted">AI-authored</dt>
                      <dd className="tabular-nums">
                        {value(m, m.ai)}{' '}
                        <span className="text-xs text-fg-muted">
                          n={m.aiSample} {m.sampleUnit}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-fg-muted">Human</dt>
                      <dd className="tabular-nums">
                        {value(m, m.human)}{' '}
                        <span className="text-xs text-fg-muted">
                          n={m.humanSample} {m.sampleUnit}
                        </span>
                      </dd>
                    </div>
                  </dl>
                  <p className="text-xs text-fg-muted">{m.basis}</p>
                  {m.note ? <p className="text-xs text-fg-muted">{m.note}</p> : null}
                </li>
              ))}
            </ul>
            {!data.findingsMeasured ? (
              <p className="text-xs text-fg-muted" data-testid="governance-findings-unmeasured">
                Findings per KLOC is not measured here: no scan or analysis pass finished in this
                window, so a zero would mean &ldquo;nobody looked&rdquo;, not &ldquo;nothing
                found&rdquo;.
              </p>
            ) : data.unattributedFindings > 0 ? (
              <p className="text-xs text-fg-muted" data-testid="governance-unattributed">
                {data.unattributedFindings} findings could not be traced to a classified change and
                are left out of findings per KLOC.
              </p>
            ) : null}
          </div>
        </WidgetFrame>
      )}

      <section className="panel flex flex-col gap-2 p-4 text-sm" data-testid="governance-method">
        <SectionHeader title="How changes are classified" as="h2" />
        <ul className="ml-4 list-disc text-xs text-fg-muted">
          <li>
            AI-authored: a co-author, assisted-by or generated-by trailer naming a coding agent, a
            commit by an agent&rsquo;s bot account, or a pull request from an agent&rsquo;s branch
            prefix.
          </li>
          <li>Human: everything else written by a person.</li>
          <li>
            Automation (dependency bots, release tooling) and changes ingested before these signals
            were recorded are counted and left out.
          </li>
          <li>
            Directions are words about AI relative to human — never a grade, and never per person. A
            measure below its minimum sample says so instead of guessing.
          </li>
        </ul>
        {me?.role === 'admin' ? (
          <Link
            to="/admin/settings"
            search={{} as never}
            className="min-h-6 w-fit text-xs text-fg underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="governance-patterns-link"
          >
            Edit the authorship patterns →
          </Link>
        ) : (
          <p className="text-xs text-fg-muted">An admin can edit the patterns under Settings.</p>
        )}
      </section>
    </div>
  );
}
