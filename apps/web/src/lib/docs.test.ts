import { describe, expect, it } from 'vitest';
import { docsUrl } from './docs.js';

// W16-24. Three `definitionHref` links pointed at `/docs/INSTALL.md` and
// `/docs/design/METRICS.md`; the app does not serve `/docs`, so all three
// landed on the not-found page — including the ⓘ on "Connect an organisation",
// the screen a new admin is sent to and the one place they most need help.
//
// Serving the markdown from the app was the alternative and it is worse: the
// shipping shape is a container whose image carries no repository, so a
// customer has no checkout for a relative path to resolve against.
describe('docsUrl (W16-24)', () => {
  it('produces an absolute URL a container install can actually open', () => {
    const url = docsUrl('docs/INSTALL.md#connect-your-forge');
    expect(url).toMatch(/^https:\/\//);
    expect(url).toContain('docs/INSTALL.md#connect-your-forge');
  });

  it('accepts both spellings the call sites already use', () => {
    // The API writes `docs/INSTALL.md#sign-in`; the widgets wrote
    // `/docs/design/METRICS.md`. Neither should have to change to call this.
    expect(docsUrl('/docs/design/METRICS.md')).toBe(docsUrl('docs/design/METRICS.md'));
  });

  it('never emits a double slash between base and path', () => {
    expect(docsUrl('/docs/INSTALL.md')).not.toMatch(/[^:]\/\//);
  });
});
