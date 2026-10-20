import { describe, expect, it } from 'vitest';
import { filterScopeFor } from './filterScope.js';

// W16-50. The topbar offered three global filters on every screen. Two of them
// did nothing ANYWHERE — the repository picker was never given options and no
// screen read `?repos=` or `?person=` — and `window` was decorative on half the
// product: the org PR list is not windowed, findings have no time dimension,
// Reports carries its own window control, and Plans hardcoded 30d while the
// global control sat directly above the button.

describe('which global filters a screen applies (W16-50)', () => {
  it('offers the repository picker only where it narrows a cross-repo list', () => {
    expect(filterScopeFor('/repos').repos).toBe(true);
    expect(filterScopeFor('/pull-requests').repos).toBe(true);
    expect(filterScopeFor('/findings').repos).toBe(true);
  });

  it('does not offer it on a screen that IS one repository', () => {
    // A picker here could contradict the page you are on, which is worse than
    // offering none.
    for (const path of ['/repos/12', '/repos/12/hotspots', '/repos/12/prs/3']) {
      expect(filterScopeFor(path).repos, path).toBe(false);
    }
  });

  it('does not offer it on the org overview, which cannot honour it', () => {
    // Nine widgets over five org-rollup endpoints with no repo_id. The choice
    // is five API changes or a control that narrows three and ignores six.
    expect(filterScopeFor('/').repos).toBe(false);
    expect(filterScopeFor('/').window).toBe(true);
  });

  it('offers the person filter only where a person narrows anything', () => {
    expect(filterScopeFor('/pull-requests').person).toBe(true);
    // My Focus is already scoped to one person: you.
    expect(filterScopeFor('/me').person).toBe(false);
    expect(filterScopeFor('/findings').person).toBe(false);
  });

  it('drops the window where the screen does not apply one', () => {
    expect(filterScopeFor('/pull-requests').window).toBe(false);
    expect(filterScopeFor('/findings').window).toBe(false);
    expect(filterScopeFor('/reports').window).toBe(false);
    expect(filterScopeFor('/views').window).toBe(false);
    expect(filterScopeFor('/admin/sync').window).toBe(false);
  });

  it('offers the Plans page the window AND the repository set it generates over (W17-24)', () => {
    expect(filterScopeFor('/plans')).toEqual({ window: true, repos: true, person: false });
  });

  it('offers the window only on repository tabs that read it (DSH-62), and governance both (DSH-61)', () => {
    for (const path of [
      '/repos/12',
      '/repos/12/',
      '/repos/12/activity',
      '/repos/12/hotspots',
      '/repos/12/pr-flow',
      '/repos/12/ai-reviewers',
      '/repos/12/ci',
      '/repos/12/prs',
    ]) {
      expect(filterScopeFor(path).window, path).toBe(true);
    }
    for (const path of [
      '/repos/12/security',
      '/repos/12/findings',
      '/repos/12/code-health',
      '/repos/12/performance',
      '/repos/12/files/src/a.ts',
      '/repos/12/prs/3',
    ]) {
      expect(filterScopeFor(path).window, path).toBe(false);
    }
    expect(filterScopeFor('/governance')).toEqual({ window: true, repos: true, person: false });
  });

  it('gives an unrecognised path nothing at all', () => {
    // A screen nobody has checked has not earned a filter. Defaulting the other
    // way is how all three came to be offered everywhere in the first place.
    expect(filterScopeFor('/something-new')).toEqual({
      window: false,
      repos: false,
      person: false,
    });
  });
});

describe('sensitive changes (W20-15, UX_TODO X-26)', () => {
  it('shows the repository picker, because the page honours ?repos=', () => {
    // Reviews carries ?repos= across; without the picker the narrowing was
    // invisible and could not be cleared.
    expect(filterScopeFor('/sensitive-changes')).toEqual({
      window: false,
      repos: true,
      person: false,
    });
  });
});
