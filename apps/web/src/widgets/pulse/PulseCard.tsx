import { WidgetFrame, frameState } from '../../components/index.js';
import { registerWidget, type WidgetComponentProps } from '../../components/widget/WidgetRegistry.js';
import { useApiQuery } from '../../api/useApiQuery.js';

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
}

/** Paired glyph + word; direction never depends on colour (UX_SPEC §7). */
const MARK: Record<PulseBullet['direction'], string> = {
  better: '▲',
  worse: '▼',
  flat: '–',
  unknown: '·',
};

export function PulseCard(_props: WidgetComponentProps) {
  const { data, isLoading, isError, error } = useApiQuery<PulseResponse>({ endpoint: '/org/pulse' });

  return (
    <WidgetFrame
      title="Weekly pulse"
      state={frameState({ isLoading, isError, isEmpty: data !== undefined && data.bullets.length === 0 })}
      {...(error ? { errorMessage: error.message } : {})}
      emptyMessage="Nothing to summarise yet."
    >
      <div className="flex flex-col gap-2" data-testid="pulse-card">
        <ul className="flex flex-col gap-1 text-sm">
          {(data?.bullets ?? []).map((b) => (
            <li key={b.id} className="flex gap-2">
              <span aria-hidden="true" className="text-fg-muted">
                {MARK[b.direction]}
              </span>
              <span>{b.text}</span>
            </li>
          ))}
        </ul>
        {/* Provenance chip (R-D3). "Computed" is the honest label until a
            narrate pass has actually run — a card that claimed a model wrote
            it when a template did would misrepresent where the words came
            from, which is the one thing an AI-card family must never do. */}
        <p className="text-xs text-fg-muted" data-testid="pulse-provenance">
          {data?.provenance === 'narrated' ? 'T2 · local — reworded, numbers computed' : 'computed from your warehouse'}
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
