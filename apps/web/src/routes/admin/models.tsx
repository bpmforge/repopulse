import { createFileRoute } from '@tanstack/react-router';
import { LlmProviders } from '../../widgets/admin/LlmProviders.js';

// W16-07. Admin-only by the API's requireAdmin; the tab itself is presentation.
export const Route = createFileRoute('/admin/models')({ component: LlmProviders });
