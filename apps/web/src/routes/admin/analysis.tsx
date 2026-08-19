import { createFileRoute } from '@tanstack/react-router';
import { AnalysisPolicy } from '../../widgets/admin/AnalysisPolicy.js';

// W7-08. Admin-only by the API's requireAdmin; the tab itself is presentation.
export const Route = createFileRoute('/admin/analysis')({ component: AnalysisPolicy });
