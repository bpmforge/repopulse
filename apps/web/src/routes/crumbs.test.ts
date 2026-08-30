import { describe, expect, it } from 'vitest';
import { deriveCrumbs } from './__root.js';

// The trail that never named the repository (W16-42).
//
// A repository's name is not in its URL — `/repos/34083/security` carries an
// id — so the breadcrumb read "Org › Repos › Security" on a product whose
// entire premise is drilling down org → repo → PR → file. __root's own comment
// has said since W16-05 that this crumb "has to come from the screen that
// loaded it". This is that half, and the part worth testing is not that it
// appears — it is that it appears ONLY where it belongs.

const payments = { pathPrefix: '/repos/34083', label: 'payments', to: '/repos/34083' };

describe('deriveCrumbs', () => {
  it('names the repository between the section and the tab', () => {
    expect(deriveCrumbs('/repos/34083/security', payments).map((c) => c.label)).toEqual([
      'Org',
      'Repos',
      'payments',
      'Security',
    ]);
  });

  it('is unchanged when no screen has published one', () => {
    expect(deriveCrumbs('/repos/34083/security', null).map((c) => c.label)).toEqual([
      'Org',
      'Repos',
      'Security',
    ]);
  });

  it('REFUSES a crumb that belongs to a different path', () => {
    // The failure this prevents: navigating from one repo to another, or out of
    // the section entirely, while the previous repo's name is still in the
    // store. A trail that is confidently wrong is worse than a thin one — it
    // tells you that you are looking at something you are not.
    expect(deriveCrumbs('/repos/99999/security', payments).map((c) => c.label)).toEqual([
      'Org',
      'Repos',
      'Security',
    ]);
    expect(deriveCrumbs('/findings', payments).map((c) => c.label)).toEqual(['Org', 'Findings']);
  });

  it('links the repository crumb back to the repo, so the trail is navigable', () => {
    const crumbs = deriveCrumbs('/repos/34083/code-health', payments);
    expect(crumbs.find((c) => c.label === 'payments')?.to).toBe('/repos/34083');
    // The last crumb is where you are, so it goes nowhere.
    expect(crumbs.at(-1)?.to).toBeUndefined();
  });

  it('still skips a numeric id when nothing named it', () => {
    // "Org › Repos › 34083" would be worse than saying nothing — the same
    // mistake F11 was about, and the reason this was left unfinished.
    expect(deriveCrumbs('/repos/34083').map((c) => c.label)).toEqual(['Org', 'Repos']);
  });
});
