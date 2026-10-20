import { createFileRoute } from '@tanstack/react-router';
import { SetupChecklist } from '../../widgets/admin/SetupChecklist.js';

// Settings → Setup (W20-17, UX_TODO ADM-20). See widgets/admin/SetupChecklist.
export const Route = createFileRoute('/admin/setup')({ component: () => <SetupChecklist /> });
