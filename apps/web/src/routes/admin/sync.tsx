import { createFileRoute } from '@tanstack/react-router';
import { SyncOps } from '../../widgets/admin/SyncOps.js';

export const Route = createFileRoute('/admin/sync')({ component: SyncOps });
