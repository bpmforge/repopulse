import { createFileRoute } from '@tanstack/react-router';
import { Connections } from '../../widgets/admin/Connections.js';

export const Route = createFileRoute('/admin/')({ component: Connections });
