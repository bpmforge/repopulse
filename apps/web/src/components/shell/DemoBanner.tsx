import { useApiQuery } from '../../api/useApiQuery.js';
import type { MeContext } from '../../widgets/org/contracts.js';

// Demo-mode banner (W13-02, UX_SPEC §7 — never colour alone).
//
// Demo mode serves fixture data through the real screens, which is exactly what
// makes it useful and exactly what makes it dangerous: the product looks the
// same whether the numbers describe a real organization or three invented
// repositories. Anyone screenshotting this needs to see that it is fake without
// being told.
//
// Rendered from the SERVER's answer, not a build-time flag: the browser cannot
// know what forge the API it is talking to is actually connected to.

export function DemoBanner() {
  const { data: me } = useApiQuery<MeContext>({ endpoint: '/me/context' });
  // `=== true`, not truthy: an older API that does not send the field at all
  // must render nothing rather than something ambiguous.
  if (me?.demo !== true) return null;

  return (
    <div
      className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-fg"
      data-testid="demo-banner"
      role="status"
    >
      <span aria-hidden="true">●</span>
      <span>
        {/* W20-17 (UX_TODO INS-47): sign-in here is a real password; it is the
            forge sign-in that is mocked. */}
        <strong>Demo mode</strong> — fake forge, mocked forge sign-in, seeded fixture data. Nothing
        here describes a real organization.
      </span>
    </div>
  );
}
