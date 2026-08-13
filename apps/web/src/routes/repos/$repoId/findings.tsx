import { createFileRoute } from '@tanstack/react-router';
import { WidgetFrame } from '../../../components/index.js';

// Findings is a v1.x surface (W6 Tier-2 analysis). The tab exists now so the
// navigation shape is stable and the teaser is honest about WHY it is empty,
// rather than the tab appearing later and moving everything else.
export const Route = createFileRoute('/repos/$repoId/findings')({
  component: FindingsTeaser,
});

function FindingsTeaser() {
  return (
    <WidgetFrame
      title="Findings"
      state="empty"
      emptyMessage="Code review findings arrive with Tier-2 analysis (wave W6). Tier-1 metrics on the other tabs need no LLM and are live today."
      data-testid="findings-teaser"
    />
  );
}
