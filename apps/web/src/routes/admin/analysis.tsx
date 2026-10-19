import { createFileRoute } from '@tanstack/react-router';
import { AnalysisPolicy } from '../../widgets/admin/AnalysisPolicy.js';
import { LastChanged } from '../../widgets/admin/AuditLog.js';

// W7-08. Admin-only by the API's requireAdmin; the tab itself is presentation.
export const Route = createFileRoute('/admin/analysis')({ component: Analysis });

// W20-10 (UX_TODO X-04): an AI opt-in decides what leaves the network, so who
// last changed this page's policy is on it.
function Analysis() {
  return (
    <div className="flex flex-col gap-2">
      <LastChanged
        events={[
          'repo.tier3_opt_in_changed',
          'scanner.enablement_changed',
          'ai_pass_settings.updated',
          'ai_pass_schedule.enabled',
          'ai_pass_schedule.disabled',
          'ai_pass_schedule.updated',
        ]}
        testId="analysis-last-changed"
      />
      <AnalysisPolicy />
    </div>
  );
}
