import { createFileRoute } from '@tanstack/react-router';
import { Identities } from '../../widgets/admin/Identities.js';

// W5-05. Merging decides WHO the ownership and bus-factor numbers describe,
// so it sits with the settings that decide what they mean.
export const Route = createFileRoute('/admin/identities')({
  component: Identities,
});
