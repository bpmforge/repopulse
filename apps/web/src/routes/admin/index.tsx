import { createFileRoute } from '@tanstack/react-router';
import { Connections } from '../../widgets/admin/Connections.js';
import { SystemStatus } from '../../widgets/admin/SystemStatus.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { ConnectionList } from '../../widgets/admin/contracts.js';
import { CiTokenExpiryNotice } from '../../widgets/admin/CiTokenExpiry.js';

// Settings landing (W17-08).
//
// System health sits ABOVE connections rather than replacing them. The landing
// page is where an operator arrives when something is wrong, so "is this
// install working?" has to be the first thing on it — but /admin/ has always
// rendered Connections, and moving that would break every bookmark and every
// test that treats this URL as the connections screen. Both, in the order that
// matters.
//
// W20-14 (UX_TODO INS-24): until the first connection exists, the order that
// matters is the other one. An admin sent here by "Connect an organization"
// landed on health tiles (worse on a phone) with the form below them. Same
// query the Connections widget makes, so this costs no extra request.
function AdminHome() {
  const { data } = useApiQuery<ConnectionList>({ endpoint: '/connections' });
  const connectFirst = data !== undefined && data.items.length === 0;
  return (
    // CSS order, not a reordered tree: swapping the elements would remount
    // Connections the moment the first connect succeeds, and drop the
    // "now choose repositories" state that connect just set up.
    <div className="flex flex-col gap-6" data-testid="admin-home" data-connect-first={connectFirst}>
      <div className={connectFirst ? 'order-2' : 'order-1'}>
        <SystemStatus />
        {/* W20-15 (UX_TODO X-19): before a pipeline starts failing. */}
        <CiTokenExpiryNotice />
      </div>
      <div className={connectFirst ? 'order-1' : 'order-2'}>
        <Connections />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/admin/')({ component: AdminHome });
