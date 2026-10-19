import { createFileRoute } from '@tanstack/react-router';
import { AccountSettings } from '../widgets/me/AccountSettings.js';

// Your own settings (W20-04, UX_TODO ADM-04): theme, home screen, password,
// sign out. Open to every signed-in person, unlike /admin.
export const Route = createFileRoute('/account')({
  component: AccountSettings,
});
