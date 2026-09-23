import { useEffect, useState } from 'react';

// Which of the two detail presentations a viewport gets (W17-22).
//
// Wide: the panel sits beside/below the list (split pane). Narrow: it covers
// the list as an overlay dialog, because a 390px column has no room for both.
// Selection is URL state in BOTH — this hook decides only how the open finding
// is drawn, never whether it is open.

export const OVERLAY_BELOW_PX = 1024;
const QUERY = `(max-width: ${OVERLAY_BELOW_PX - 1}px)`;

function matchesNow(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(QUERY).matches
  );
}

/** True when the detail should render as an overlay rather than inline. */
export function useOverlayLayout(): boolean {
  const [overlay, setOverlay] = useState(matchesNow);
  useEffect(() => {
    // Guarded like the rail: matchMedia is absent in jsdom, and an unguarded
    // call would throw while mounting the whole explorer. Without it the
    // panel is simply inline, which is what every viewport got before W17-22.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(QUERY);
    const onChange = (e: { matches: boolean }) => setOverlay(e.matches);
    onChange(mq);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return overlay;
}
