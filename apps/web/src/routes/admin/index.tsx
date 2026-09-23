import { createFileRoute } from '@tanstack/react-router';
import { Connections } from '../../widgets/admin/Connections.js';
import { SystemStatus } from '../../widgets/admin/SystemStatus.js';

// Settings landing (W17-08).
//
// System health sits ABOVE connections rather than replacing them. The landing
// page is where an operator arrives when something is wrong, so "is this
// install working?" has to be the first thing on it — but /admin/ has always
// rendered Connections, and moving that would break every bookmark and every
// test that treats this URL as the connections screen. Both, in the order that
// matters.
function AdminHome() {
  return (
    <div className="flex flex-col gap-6">
      <SystemStatus />
      <Connections />
    </div>
  );
}

export const Route = createFileRoute('/admin/')({ component: AdminHome });
