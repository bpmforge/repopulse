import { createFileRoute, useParams, useSearch } from '@tanstack/react-router';
import { WidgetFrame } from '../../../components/index.js';
import { AiPassPanel } from '../../../widgets/repo/AiPassPanel.js';

// Repo → AI review (W24-04, UX review: "the AI panel is buried in the Security
// tab"). The AI review pass - start one, watch it, its history and its
// schedule - sat on the Security tab under an 18-row scanner table and the open
// findings, a long scroll down on a laptop and further on a phone. It is a
// thing people come to do, not a status to glance at, so it has its own tab.
// The anchor `#ai-review-pass` and `?ai_path=` work here as they did there.

/**
 * `?ai_path=` (W20-11, UX_TODO AI-44): a finding's "start a pass on this file"
 * link lands here with the file already in the AI review pass box. Lenient: a
 * junk value is dropped, never a white screen.
 */
export function validateAiReviewSearch(search: Record<string, unknown>): { ai_path?: string } {
  const raw = search.ai_path;
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 500 ? { ai_path: raw } : {};
}

export const Route = createFileRoute('/repos/$repoId/ai-review')({
  validateSearch: validateAiReviewSearch,
  component: AiReviewTab,
});

function AiReviewTab() {
  const { repoId } = useParams({ from: '/repos/$repoId/ai-review' });
  const aiPath = (useSearch({ strict: false }) as { ai_path?: string }).ai_path;
  return (
    <div className="flex flex-col gap-4" data-testid="ai-review-tab">
      <WidgetFrame title="AI review pass" state="ready" testId="repo-ai-pass">
        <AiPassPanel repoId={repoId} initialPaths={aiPath} />
      </WidgetFrame>
    </div>
  );
}
