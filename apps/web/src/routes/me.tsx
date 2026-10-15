import { createFileRoute } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { MyFocus } from '../widgets/me/MyFocus.js';
import { PageHeader } from '../components/index.js';

// The rail's "My Focus" destination (UX_SPEC §4.f).
export const Route = createFileRoute('/me')({
  component: MyFocusRoute,
});

function MyFocusRoute() {
  const search = Route.useSearch();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="My Focus"
        description="Your open pull requests, the reviews waiting on you, and the hotspots you own."
      />
      <MyFocus search={serializeGlobalSearch(search)} />
    </div>
  );
}
