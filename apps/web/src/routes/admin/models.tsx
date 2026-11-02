import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useApiQuery } from '../../api/useApiQuery.js';
import { ModelsWizard } from '../../widgets/admin/ModelsWizard.js';
import { LlmProviders } from '../../widgets/admin/LlmProviders.js';
import { LlmRouting } from '../../widgets/admin/LlmRouting.js';
import { ModelEval } from '../../widgets/admin/ModelEval.js';
import { ModelCache } from '../../widgets/admin/ModelCache.js';
import { LastChanged } from '../../widgets/admin/AuditLog.js';

// W16-07, W19-02. Admin-only by the API's requireAdmin; the tab itself is presentation.
//
// W24-01 (UX review: "the setup wizard sits above a duplicate Models form"). The
// page opened on the four-step wizard at full size even when connections were
// already set up, with a second "Models" form for the same job below it. Now:
//
//   - no connection yet: the guided setup is open, first, and the by-hand form
//     sits folded inside it as the Advanced route;
//   - connections exist: the page opens on what is configured, and the setup
//     (guided and by hand together) folds behind "Set up another model".

const LIST = { endpoint: '/admin/llm-providers' } as const;

/**
 * The guided setup and the by-hand form, as one block. Kept mounted at the same
 * place in the tree whether or not connections exist, so saving the first
 * connection in the wizard does not unmount it halfway through choosing roles.
 */
function ModelSetup({ startOpen }: { startOpen: boolean }) {
  const body = (
    <div className="flex flex-col gap-3">
      <ModelsWizard />
      <LlmProviders section="form" />
    </div>
  );
  // With nothing configured the setup IS the page; no fold to open first.
  if (startOpen) return <div data-testid="models-setup">{body}</div>;
  return (
    <details className="group" data-testid="models-setup">
      <summary
        className="w-fit cursor-pointer rounded-sm border border-border bg-surface-2 px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid="models-setup-toggle"
      >
        Set up another model
      </summary>
      <div className="mt-3">{body}</div>
    </details>
  );
}

function Models() {
  const list = useApiQuery<{ items: unknown[] }>(LIST);
  // Decided once, from the first answer: whether the page opens on the setup
  // or on what is configured. A connection saved here later does not fold the
  // setup away under the person using it.
  const [startOpen, setStartOpen] = useState<boolean | null>(null);
  if (startOpen === null && list.data) setStartOpen(list.data.items.length === 0);
  const configuredFirst = startOpen === false;

  return (
    <div className="flex flex-col gap-4">
      {configuredFirst ? <LlmProviders section="list" /> : null}
      {startOpen === null ? null : <ModelSetup startOpen={startOpen} />}
      {configuredFirst ? null : startOpen === null ? null : <LlmProviders section="list" />}
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
      {/* W23-06: is the static prompt prefix actually being reused? */}
      <ModelCache />
    </div>
  );
}

export const Route = createFileRoute('/admin/models')({ component: Models });
