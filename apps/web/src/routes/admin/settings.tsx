import { createFileRoute } from '@tanstack/react-router';
import { Settings } from '../../widgets/admin/settings/Settings.js';

// Admin → Settings (W4-09).
export const Route = createFileRoute('/admin/settings')({
  component: Settings,
});
