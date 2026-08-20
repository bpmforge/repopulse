import { useApiQuery } from '../../api/useApiQuery.js';
import type { RiskAxesResponse } from './contracts.js';

// The repo-header axis strip (W10-05, RISK_MODEL.md §4, FR-RISK-6).
//
// Four letters beside the health grade, each with its axis name — and where an
// axis has no sub-score, a dash with "not measured" rather than a letter. The
// rule is the same one that governs the card: a grade nobody measured is a
// fake grade (FR-INSIGHTS-3), and the basis travels with the letter.

const AXIS_LABEL: Record<string, string> = {
  security: 'Security',
  codeHealth: 'Code Health',
  supplyChain: 'Supply Chain',
  performance: 'Performance',
};

export function RiskAxisStrip({ repoId }: { repoId: string }) {
  const { data } = useApiQuery<RiskAxesResponse>({
    endpoint: '/risk/axes',
    query: { repo_id: repoId },
  });

  const axes = data?.axes ?? [];
  if (axes.length === 0) return null;

  return (
    <ul className="flex flex-wrap items-center gap-3 text-xs" data-testid="risk-axis-strip">
      {axes.map((axis) => (
        <li key={axis.axis} className="flex items-center gap-1" title={axis.basis}>
          <span
            className="font-semibold"
            data-testid={`axis-strip-letter-${axis.axis}`}
            aria-label={
              axis.letter
                ? `${AXIS_LABEL[axis.axis] ?? axis.axis} grade ${axis.letter}`
                : `${AXIS_LABEL[axis.axis] ?? axis.axis} not measured`
            }
          >
            {axis.letter ?? '—'}
          </span>
          <span className="text-fg-muted">{AXIS_LABEL[axis.axis] ?? axis.axis}</span>
          {/* Screen readers get the basis as text, not only as a tooltip. */}
          <span className="sr-only">{axis.basis}</span>
        </li>
      ))}
    </ul>
  );
}
