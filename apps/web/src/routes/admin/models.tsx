import { createFileRoute } from '@tanstack/react-router';
import { ModelsWizard } from '../../widgets/admin/ModelsWizard.js';
import { LlmProviders } from '../../widgets/admin/LlmProviders.js';
import { LlmRouting } from '../../widgets/admin/LlmRouting.js';
import { ModelEval } from '../../widgets/admin/ModelEval.js';
import { LastChanged } from '../../widgets/admin/AuditLog.js';

// W16-07, W19-02. Admin-only by the API's requireAdmin; the tab itself is presentation.
function Models() {
  return (
    <div className="flex flex-col gap-4">
      <ModelsWizard />
      <p className="text-xs text-fg-muted">
        The wizard above uses the same settings as the forms below, which stay available for
        editing, routing and removing connections.
      </p>
      <LlmProviders />
      {/* W20-10 (UX_TODO X-04): routing decides where diffs are sent. */}
      <LastChanged
        events={[
          'llm_routing.updated',
          'llm_provider.created',
          'llm_provider.updated',
          'llm_provider.deleted',
        ]}
        testId="models-last-changed"
      />
      <LlmRouting />
      <ModelEval />
    </div>
  );
}

export const Route = createFileRoute('/admin/models')({ component: Models });
