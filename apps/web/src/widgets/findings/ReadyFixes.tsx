import { ErrorNote } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { FindingSeverityBadge } from './FindingSeverity.js';

// "Fixes ready to apply" (W22-09, CLOSE_THE_LOOP.md).
//
// After a scan the AI judges the rule hits; for the riskiest it confirms, a
// model drafts a fix, Repo Pulse applies it to the scanned commit and re-runs
// the rule, and only a fix that cleared the finding without raising a new one
// is listed here. A draft the re-scan rejected is never listed (the API does
// not send it). Opening one shows the diff in the finding's drawer, with Copy
// and Download: Repo Pulse writes nothing to the repository (D9a).
//
// Renders nothing while there is no ready fix, so the findings page is not
// given an empty box to explain.

export interface ReadyFix {
  patch_id: number;
  finding_id: number;
  title: string;
  file: string | null;
  line_start: number | null;
  severity: number;
  dimension: string;
  effective_risk: number | null;
  verify_status: string;
  repo: { id: number; name: string };
  commit_sha: string;
  model_id: string | null;
  drafted_by: 'auto' | 'person';
  finished_at: string | null;
}

export interface ReadyFixesResponse {
  items: ReadyFix[];
}

export function ReadyFixes({
  repos,
  onOpen,
}: {
  /** The topbar's repository filter (comma-separated ids), when set. */
  repos?: string | undefined;
  onOpen: (findingId: number) => void;
}) {
  const { data, error } = useApiQuery<ReadyFixesResponse>({
    endpoint: '/patches/ready',
    ...(repos ? { query: { repo_id: repos } } : {}),
  });
  if (error) return <ErrorNote error={error} testId="ready-fixes-error" />;
  const items = data?.items ?? [];
  if (items.length === 0) return null;

  return (
    <section
      className="rounded-md border border-border bg-surface p-3"
      aria-labelledby="ready-fixes-heading"
      data-testid="ready-fixes"
    >
      <h2 id="ready-fixes-heading" className="text-sm font-medium text-fg">
        Fixes ready to apply ({items.length})
      </h2>
      <p className="mt-1 text-xs text-fg-muted">
        Each fix was applied to the scanned commit and re-scanned: the finding cleared and nothing
        new fired. Open one to copy or download the patch and apply it with your own tools; Repo
        Pulse does not change your repository.
      </p>
      <ul className="mt-2 divide-y divide-border">
        {items.map((f) => (
          <li key={f.patch_id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
            <FindingSeverityBadge severity={f.severity} />
            <button
              type="button"
              className="text-left text-fg underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid={`ready-fix-${f.finding_id}`}
              onClick={() => onOpen(f.finding_id)}
            >
              {f.title}
            </button>
            <span className="font-mono text-xs text-fg-muted">
              {f.file}
              {f.line_start !== null ? `:${f.line_start}` : ''}
            </span>
            <span className="text-xs text-fg-muted">{f.repo.name}</span>
            {f.verify_status === 'confirmed' ? (
              <span className="text-xs text-fg-muted">AI-confirmed</span>
            ) : null}
            {f.drafted_by === 'auto' ? (
              <span
                className="text-xs text-fg-muted"
                data-testid={`ready-fix-auto-${f.finding_id}`}
              >
                drafted after the scan
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
