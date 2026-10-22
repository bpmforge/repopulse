// Where the documentation actually lives, from the app's point of view (W16-24).
//
// Three `definitionHref` links pointed at `/docs/INSTALL.md` and
// `/docs/design/METRICS.md`. The app does not serve `/docs`, so all three
// resolved to the not-found page — including the ⓘ on "Connect an
// organization", which is the screen a new admin is sent to by the welcome
// state and the one place they most need to know what credential to create.
//
// The setup checklist had the same problem in a quieter form: it printed
// "See docs/INSTALL.md#connect-your-forge" as PLAIN TEXT, unclickable.
//
// Serving the markdown from the app was the other option and it is worse: the
// shipping shape is a container, whose image does not carry the repository, and
// a customer has no checkout to open a relative path from. An absolute URL to
// the published source works from a container, a laptop and a phone alike.
//
// Overridable because a customer running an air-gapped install, or a fork with
// its own documentation, should be able to point this at their own copy rather
// than at ours.

const DOCS_REPO = 'https://github.com/bpmforge/repopulse/blob';

/**
 * `VITE_DOCS_BASE_URL`, or the public repository at `VITE_DOCS_REF`.
 *
 * W20-22 (UX_TODO ADM-31): `VITE_DOCS_REF` pins the links to a release's own
 * tag, so an install reads the docs for the version it runs rather than
 * whatever `main` says today. W20-25: the release image build sets it to
 * `v<version>` (Dockerfile ARG DOCS_REF, passed by deploy/bundle.sh); a
 * development build leaves it unset and links to `main`.
 */
export function docsBase(env: Record<string, unknown> | undefined = import.meta.env): string {
  const configured = env?.VITE_DOCS_BASE_URL;
  if (typeof configured === 'string' && configured !== '') return configured.replace(/\/+$/, '');
  const ref = env?.VITE_DOCS_REF;
  return `${DOCS_REPO}/${typeof ref === 'string' && ref !== '' ? encodeURIComponent(ref) : 'main'}`;
}

/**
 * An absolute URL for a repository-relative documentation path.
 *
 * Accepts what the API and the widgets already write — `docs/INSTALL.md#sign-in`
 * or `/docs/design/METRICS.md` — so call sites do not have to agree on a
 * leading slash.
 */
export function docsUrl(path: string): string {
  return `${docsBase()}/${path.replace(/^\/+/, '')}`;
}
