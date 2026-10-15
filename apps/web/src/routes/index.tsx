import { createFileRoute } from '@tanstack/react-router';
import { OrgOverview } from '../widgets/org/OrgOverview.js';
import { PageHeader } from '../components/index.js';

// Org Overview — the landing screen (UX_SPEC §4.a). Everything it renders reads
// our own Postgres through /api/v1 (Law 4); the route itself only wires the
// validated global filters from __root into the screen.
export const Route = createFileRoute('/')({
  component: OrgOverviewRoute,
});

function OrgOverviewRoute() {
  const search = Route.useSearch();
  // The page's h1 lives here, not in OrgOverview, so the widget stays
  // embeddable (W18-28: the landing screen had no heading at all).
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Overview"
        description="Delivery, code health and risk across every tracked repository."
      />
      <OrgOverview search={search} />
    </div>
  );
}
