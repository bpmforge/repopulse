import { createFileRoute } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { PageHeader } from '../components/index.js';
import { AiGovernanceDetail } from '../widgets/org/AiGovernanceDetail.js';

// AI-code governance (W18-29). Reached from the Overview tile; the comparison
// is W18-20's GET /org/ai-governance.
export const Route = createFileRoute('/governance')({
  component: GovernanceRoute,
});

function GovernanceRoute() {
  const search = Route.useSearch();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="AI-code governance"
        description="How AI-authored changes compare with human ones over this window — aggregated signals, never per person."
      />
      <AiGovernanceDetail window={search.window} search={serializeGlobalSearch(search)} />
    </div>
  );
}
