import { useEffect, useRef } from 'react';

/**
 * UI-10 (UI review 2026-11-06): a tab strip that scrolls sideways on a phone
 * must show the tab you are on. Without this, /admin opened on "Members" with
 * the active "Connections" off-screen, and a repository's "Code health" tab
 * sat half cut off. Scrolls the strip itself (never the page) so the active
 * link is fully visible, whenever `key` (the pathname) changes.
 */
export function useActiveTabInView<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const strip = ref.current;
    if (!strip || strip.scrollWidth <= strip.clientWidth) return;
    const active = strip.querySelector<HTMLElement>('[data-active="true"]');
    if (!active) return;
    const left = active.offsetLeft - strip.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - 16);
    else if (right > strip.scrollLeft + strip.clientWidth)
      strip.scrollLeft = right - strip.clientWidth + 16;
  }, [key]);
  return ref;
}
