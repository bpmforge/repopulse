import { createFileRoute, redirect } from '@tanstack/react-router';

// /setup is an alias (W20-17, UX_TODO ADM-20). The checklist now lives at
// /admin/setup, inside the Settings layout, so the tabs stay put and members
// get the ask-an-admin copy (INS-19). Old links, the System health actions and
// bookmarks still land on it.
export const Route = createFileRoute('/setup/')({
  beforeLoad: () => {
    throw redirect({ to: '/admin/setup', replace: true } as never);
  },
});
