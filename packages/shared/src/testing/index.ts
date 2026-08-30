export * from './route-walker.js';
export * from './local-users.js';
export * from './seed/index.js';

// The fakes (W13-02). They live here, not in e2e/, because demo mode runs them
// as a REAL PROCESS outside the Playwright harness: `pnpm dev` with DEMO_MODE
// serves the whole app against them so a newcomer can see it work with no
// GitHub account. A fixture that only a test runner can start cannot do that.
export * from './fake/forge.js';
export * from './fake/tarball.js';
export * from './fake/github.js';
