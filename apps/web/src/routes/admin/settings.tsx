import { createFileRoute } from '@tanstack/react-router';
import { Settings } from '../../widgets/admin/settings/Settings.js';
import { LastChanged } from '../../widgets/admin/AuditLog.js';

// Admin → Settings (W4-09).
export const Route = createFileRoute('/admin/settings')({
  component: SettingsPage,
});

// W20-10 (UX_TODO X-04): these settings move every number on every screen, so
// who last changed them, and when, is on the page.
function SettingsPage() {
  return (
    <div className="flex flex-col gap-2">
      <LastChanged events={['workspace.settings.updated']} testId="settings-last-changed" />
      <Settings />
    </div>
  );
}
