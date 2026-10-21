import { EvidenceLink } from '../org/EvidenceLink.js';
import { presetCovering } from '@repopulse/shared/url-state';
import { WidgetFrame, frameState } from '../../components/index.js';
import { metricEvidence } from '../org/metricLinks.js';
import {
  registerWidget,
  type WidgetComponentProps,
} from '../../components/widget/WidgetRegistry.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { reposParam, withRepos } from '../scopeRepos.js';

// Weekly Pulse card (W6-06, R-A7 / R-D3).

interface PulseBullet {
  id: string;
  text: string;
  direction: 'better' | 'worse' | 'flat' | 'unknown';
}

interface PulseResponse {
  bullets: PulseBullet[];
  provenance: 'template' | 'narrated';
  window: string;
  /** W20-20 (UX_TODO DSH-74): what each change is measured against. */
  compared_with?: string;
}

/** Paired glyph + word; direction never depends on colour (UX_SPEC §7). */
const MARK: Record<PulseBullet['direction'], string> = {
  better: '▲',
  worse: '▼',
  flat: '–',
  unknown: '·',
};

export function PulseCard({ widget }: WidgetComponentProps) {
  // The view's window and repositories (W20-09, UX_TODO DSH-02).
  const options = widget?.options ?? {};
  const window = typeof options.window === 'string' ? options.window : '30d';
  const repos = reposParam(options.search as Record<string, string> | undefined);
  const { data, isLoading, isError, error, refetch } = useApiQuery<PulseResponse>({
    endpoint: '/org/pulse',
    query: withRepos({ window }, repos),
  });

  // W20-20 (UX_TODO DSH-51): the card follows the window, so its title says
  // which one instead of promising a week.
  const period = presetCovering(window);
  return (
    <WidgetFrame
      title={`Pulse · last ${period}`}
      state={frameState({
        isLoading,
        isError,
        isEmpty: data !== undefined && data.bullets.length === 0,
      })}
      // W17-31: every failed frame offers Retry, like the rest of the overview.
      onRetry={() => void refetch()}
      {...(error ? { errorMessage: error.message, error } : {})}
      emptyMessage="Nothing to summarise yet."
    >
      <div className="flex flex-col gap-2" data-testid="pulse-card">
        <ul className="flex flex-col gap-1 text-sm">
          {(data?.bullets ?? []).map((b) => {
            // W20-20 (UX_TODO DSH-51): each bullet opens its evidence.
            const to = metricEvidence(b.id, repos);
            return (
              <li key={b.id} className="flex gap-2">
                <span aria-hidden="true" className="text-fg-muted">
                  {MARK[b.direction]}
                </span>
                {to ? (
                  <EvidenceLink
                    evidence={to}
                    className="hover:underline"
                    testId={`pulse-link-${b.id}`}
                  >
                    {b.text}
                  </EvidenceLink>
                ) : (
                  <span>{b.text}</span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-fg-muted" data-testid="pulse-period">
          Over the last {period}; changes compare with{' '}
          {data?.compared_with ?? `the value ${period} earlier`}.
        </p>
        {/* Provenance chip (R-D3). "Computed" is the honest label until a
            narrate pass has actually run — a card that claimed a model wrote
            it when a template did would misrepresent where the words came
            from, which is the one thing an AI-card family must never do. */}
        <p className="text-xs text-fg-muted" data-testid="pulse-provenance">
          {data?.provenance === 'narrated'
            ? 'Reworded by your local AI model; numbers computed from your warehouse'
            : 'computed from your warehouse'}
        </p>
      </div>
    </WidgetFrame>
  );
}

registerWidget({
  type: 'weekly-pulse',
  title: 'Weekly pulse',
  category: 'content',
  defaultSize: { w: 12, h: 2 },
  component: PulseCard,
});
