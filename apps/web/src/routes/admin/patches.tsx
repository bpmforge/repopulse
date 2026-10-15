import { createFileRoute } from '@tanstack/react-router';
import { VerifiedPatches } from '../../widgets/admin/VerifiedPatches.js';

// W18-29. Every verified-fix attempt and why the rejected ones were rejected.
// Admin-only by the API (GET /admin/patches answers 403 to a member).
export const Route = createFileRoute('/admin/patches')({ component: VerifiedPatches });
