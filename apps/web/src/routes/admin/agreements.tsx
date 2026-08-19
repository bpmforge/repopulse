import { createFileRoute } from '@tanstack/react-router';
import { Agreements } from '../../widgets/agreements/Agreements.js';

// W5-08. Config is admin-only (FR-AUTH-4); the exception lists it renders are
// readable by any member through the same API.
export const Route = createFileRoute('/admin/agreements')({ component: Agreements });
