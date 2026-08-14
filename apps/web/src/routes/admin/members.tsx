import { createFileRoute } from '@tanstack/react-router';
import { Members } from '../../widgets/admin/Members.js';

// W4-20: the empty state that stood here pointed at this ticket. The endpoints
// exist now, so the tab shows the real controls.
export const Route = createFileRoute('/admin/members')({
  component: Members,
});
