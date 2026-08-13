import { createFileRoute } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { MyFocus } from '../widgets/me/MyFocus.js';

// The rail's "My Focus" destination (UX_SPEC §4.f).
export const Route = createFileRoute('/me')({
  component: MyFocusRoute,
});

function MyFocusRoute() {
  const search = Route.useSearch();
  return <MyFocus search={serializeGlobalSearch(search)} />;
}
