import { WidgetFrame } from '../widget/WidgetFrame.js';

/**
 * The application's 404 (W16-24).
 *
 * This was W4-era scaffolding — "Coming soon. This screen is part of a later W4
 * ticket." — and it was still there at W16. Every unknown URL in the shipped
 * product told a customer their screen belonged to an internal ticket wave that
 * closed months ago: a typo, a stale bookmark, a deleted repository, a link
 * from an email.
 *
 * It also caught three in-app help links pointing at /docs/*, which the app does
 * not serve, so the ⓘ on "Connect an organisation" landed here — at exactly the
 * moment a new admin needs help.
 */
export function NotFound() {
  return (
    <WidgetFrame
      title="Not found"
      state="empty"
      emptyMessage="There is nothing at this address. The link may be out of date, or the repository it pointed to may no longer be tracked."
      emptyAction={
        <a
          href="/"
          data-testid="not-found-home"
          className="rounded-sm border border-border bg-accent-strong px-3 py-1.5 text-sm text-accent-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Go to Org Overview
        </a>
      }
    />
  );
}
