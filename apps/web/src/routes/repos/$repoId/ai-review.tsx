import { createFileRoute, useParams } from '@tanstack/react-router';
import { WidgetFrame } from '../../../components/index.js';
import { AiPassPanel } from '../../../widgets/repo/AiPassPanel.js';
import { AiSchedulePanel } from '../../../widgets/repo/AiSchedulePanel.js';

// AI Review tab (W19-12). The AI review pass used to sit low on the Security
// tab, under the scanner tables, where the W19 UX review found it buried. It
// has its own route like every tab, so a link to it restores it (DASHBOARD §1):
// start a pass, its schedule, and every pass - by hand or by schedule - with
// what it did and did not cover. Its answers appear on the findings.
export const Route = createFileRoute('/repos/$repoId/ai-review')({ component: AiReviewTab });

function AiReviewTab() {
  const { repoId } = useParams({ from: '/repos/$repoId/ai-review' });
  return (
    <div className="flex flex-col gap-4" data-testid="ai-review-tab">
      <WidgetFrame title="AI review pass" state="ready" testId="security-ai-pass">
        <AiPassPanel repoId={repoId} />
      </WidgetFrame>
      <WidgetFrame title="Scheduled passes" state="ready" testId="ai-review-schedule">
        <AiSchedulePanel repoId={repoId} />
      </WidgetFrame>
    </div>
  );
}
