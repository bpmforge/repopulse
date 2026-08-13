import { createFileRoute } from '@tanstack/react-router';
import { WidgetFrame } from '../../components/index.js';

// Members needs an endpoint that does not exist: /me/context returns the
// CALLER's role, but nothing lists workspace members or changes theirs. The tab
// exists so the navigation shape is stable and the gap is stated, rather than
// the tab appearing later and moving everything else.
export const Route = createFileRoute('/admin/members')({
  component: () => (
    <WidgetFrame
      title="Members"
      state="empty"
      emptyMessage="Listing members and changing roles needs an admin members endpoint that is not built yet — tracked as W4-20. Roles are enforced today; they just cannot be managed from here."
    />
  ),
});
