import { describe, expect, it } from 'vitest';
import { landingTarget } from './index.js';

// W20-05 (UX_TODO DSH-03). "Set as home" stored a choice nothing read, and a
// persona's home applied only when the picker was first answered.

describe('where / lands after sign-in', () => {
  it('opens the chosen home view first', () => {
    expect(landingTarget({ default_view_id: 12, home: '/me' })).toBe('/views/12');
  });

  it("falls back to the persona's home", () => {
    expect(landingTarget({ default_view_id: null, home: '/findings' })).toBe('/findings');
  });

  it('stays on the Overview when that IS the home, or none is known', () => {
    expect(landingTarget({ default_view_id: null, home: '/' })).toBeNull();
    expect(landingTarget({ default_view_id: null, home: null })).toBeNull();
    expect(landingTarget({ default_view_id: null })).toBeNull();
  });
});
