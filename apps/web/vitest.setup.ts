import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// We don't enable vitest `globals`, so @testing-library/react's auto-cleanup
// (which hooks a global afterEach) never registers — unmount explicitly so the
// jsdom document doesn't accumulate nodes across tests.
afterEach(() => {
  cleanup();
});

// jsdom doesn't implement scrollTo; TanStack Router's scroll restoration calls
// it on navigation. No-op it so router tests don't spew "Not implemented".
if (typeof window !== 'undefined' && typeof window.scrollTo !== 'function') {
  window.scrollTo = () => {};
}
