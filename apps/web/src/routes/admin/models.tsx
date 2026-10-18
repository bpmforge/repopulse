import { createFileRoute } from '@tanstack/react-router';
import { ModelsWizard } from '../../widgets/admin/ModelsWizard.js';
import { LlmProviders } from '../../widgets/admin/LlmProviders.js';
import { LlmRouting } from '../../widgets/admin/LlmRouting.js';
import { ModelEval } from '../../widgets/admin/ModelEval.js';

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
      <LlmRouting />
      <ModelEval />
    </div>
  );
}

export const Route = createFileRoute('/admin/models')({ component: Models });
