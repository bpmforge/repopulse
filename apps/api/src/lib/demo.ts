// Demo mode (W13-02).
//
// Demo mode serves the whole product against a LOCAL FAKE FORGE with the OAuth
// boundary mocked, so a newcomer can run RepoPulse with no GitHub account and
// no registered OAuth app. That is exactly the shape of an authentication
// bypass, so the guard below is the security control, not a convenience check:
// a demo login reachable in production is an unauthenticated door into the
// product.
//
// It fails CLOSED — refuses to boot rather than silently disabling itself.
// Silently continuing without demo mode would be worse than either outcome:
// the operator believes they are running one thing and are running another.

export const DEMO_REFUSAL =
  'DEMO_MODE cannot run with NODE_ENV=production.\n\n' +
  '  Demo mode mocks the OAuth boundary and serves a fake forge — in production\n' +
  '  that is an authentication bypass, not a demo.\n\n' +
  '  Run the production entrypoint (apps/api/src/index.ts) with real GitHub\n' +
  '  credentials, or unset NODE_ENV=production to demo locally.';

export interface DemoEnv {
  NODE_ENV?: string | undefined;
  DEMO_MODE?: string | undefined;
}

/** True when the caller asked for demo mode at all. */
export function demoRequested(env: DemoEnv): boolean {
  const flag = env.DEMO_MODE;
  // Explicit falsey spellings count as OFF. `DEMO_MODE=0` reading as ON is the
  // kind of surprise that ends with a demo login in front of real data.
  return flag !== undefined && flag !== '' && flag !== '0' && flag.toLowerCase() !== 'false';
}

/**
 * Throws unless demo mode is safe to start. Call before ANY demo wiring —
 * before binding a port, before starting the fakes.
 */
export function assertDemoAllowed(env: DemoEnv): void {
  if (env.NODE_ENV === 'production') throw new Error(DEMO_REFUSAL);
}
