import { createFileRoute } from '@tanstack/react-router';
import { Members } from '../../widgets/admin/Members.js';
import { CreateUser } from '../../widgets/auth/CreateUser.js';

// W4-20: the empty state that stood here pointed at this ticket. The endpoints
// exist now, so the tab shows the real controls.
//
// W20-01 (UX_TODO ADM-01): CreateUser was built in W15-04 but never mounted,
// so adding a member meant a curl command. It sits above the list it adds to.
export const Route = createFileRoute('/admin/members')({
  component: MembersPage,
});

export function MembersPage() {
  return (
    <div className="flex flex-col gap-4" data-testid="members-page">
      <CreateUser />
      <Members />
    </div>
  );
}
