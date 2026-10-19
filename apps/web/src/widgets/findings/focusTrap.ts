import type { KeyboardEvent } from 'react';

// Keeps Tab inside a modal dialog (W20-13, UX_TODO FND-34 / FND-42).
//
// The triage queue and the phone overlay are `aria-modal`, which tells a
// screen reader the page behind is inert; Tab did not agree, and walked out of
// the dialog into the list hidden behind it. Wired as the dialog's onKeyDown:
// Tab past the last control comes back to the first, Shift+Tab past the first
// goes to the last.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapTab(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Tab') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && e.currentTarget.contains(active);
  if (e.shiftKey && (active === first || !inside || active === e.currentTarget)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}
