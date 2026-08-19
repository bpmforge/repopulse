import { describe, expect, it } from 'vitest';
import { assertDemoAllowed, demoRequested } from './demo.js';

// W13-02. The refusal is the control being tested, not the happy path.
//
// Demo mode mocks the OAuth boundary and points the app at a fake forge. If it
// could be switched on in production it would be an unauthenticated door into
// the product, so these assertions exist to make that impossible to regress —
// including the failure mode where the guard "works" by quietly turning demo
// mode off, leaving an operator who asked for one thing running another.

describe('demo mode guard (W13-02)', () => {
  it('REFUSES to start under NODE_ENV=production', () => {
    expect(() => assertDemoAllowed({ NODE_ENV: 'production', DEMO_MODE: '1' })).toThrow(
      /cannot run with NODE_ENV=production/,
    );
  });

  it('explains why, so the refusal is actionable rather than cryptic', () => {
    // An operator who hits this needs to know it is deliberate and what to do
    // instead — a bare "refused" invites someone to delete the check.
    expect(() => assertDemoAllowed({ NODE_ENV: 'production', DEMO_MODE: '1' })).toThrow(
      /authentication bypass/,
    );
  });

  it('allows development and test', () => {
    expect(() => assertDemoAllowed({ NODE_ENV: 'development', DEMO_MODE: '1' })).not.toThrow();
    expect(() => assertDemoAllowed({ NODE_ENV: undefined, DEMO_MODE: '1' })).not.toThrow();
  });

  it('treats explicit falsey spellings as OFF, not as "set"', () => {
    // `DEMO_MODE=0` reading as ON is how a demo login ends up in front of real
    // data — the value is present, so a truthiness check on the string alone
    // would enable it.
    expect(demoRequested({ DEMO_MODE: '0' })).toBe(false);
    expect(demoRequested({ DEMO_MODE: 'false' })).toBe(false);
    expect(demoRequested({ DEMO_MODE: '' })).toBe(false);
    expect(demoRequested({})).toBe(false);
    expect(demoRequested({ DEMO_MODE: '1' })).toBe(true);
  });
});
