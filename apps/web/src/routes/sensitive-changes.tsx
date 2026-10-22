import { createFileRoute } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { PageHeader } from '../components/index.js';
import { SensitiveChanges } from '../widgets/security/SensitiveChanges.js';

// Sensitive changes (W18-29) — the radar's review list. Reached from Findings.
export const Route = createFileRoute('/sensitive-changes')({
  component: SensitiveChangesRoute,
});

function SensitiveChangesRoute() {
  const search = Route.useSearch();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Sensitive changes"
        description="Changes that loosen authentication, validation, cryptography, CORS/TLS or rate limits. Each is a signal for a person to check, not a verdict."
      />
      <SensitiveChanges search={serializeGlobalSearch(search)} />
    </div>
  );
}
