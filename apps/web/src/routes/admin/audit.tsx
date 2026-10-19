import { createFileRoute } from '@tanstack/react-router';
import { AuditLog } from '../../widgets/admin/AuditLog.js';

// W20-10 (UX_TODO X-04). Admin-only by the API's requireAdmin; the tab itself
// is presentation.
export const Route = createFileRoute('/admin/audit')({ component: AuditLog });
