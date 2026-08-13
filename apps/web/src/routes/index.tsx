import { createFileRoute } from '@tanstack/react-router';
import { OrgOverview } from '../widgets/org/OrgOverview.js';

// Org Overview — the landing screen (UX_SPEC §4.a). Everything it renders reads
// our own Postgres through /api/v1 (Law 4); the route itself only wires the
// validated global filters from __root into the screen.
export const Route = createFileRoute('/')({
  component: OrgOverviewRoute,
});

function OrgOverviewRoute() {
  const search = Route.useSearch();
  return <OrgOverview search={search} />;
}
