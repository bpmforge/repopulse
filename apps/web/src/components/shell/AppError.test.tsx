import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, isChunkLoadError, reloadForNewVersion } from './AppError.js';

// W20-17 (UX_TODO INS-57): a tab left open across an upgrade asks for chunks
// that no longer exist; it reloads once, and otherwise says why.

const reload = vi.fn();

afterEach(() => {
  reload.mockReset();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

function stubReload() {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
}

describe('stale chunk recovery', () => {
  it('recognises the browsers’ chunk-load messages and nothing else', () => {
    expect(
      isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /a.js')),
    ).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  it('reloads once, then not again within the guard window', () => {
    stubReload();
    expect(reloadForNewVersion(1_000_000)).toBe(true);
    expect(reloadForNewVersion(1_010_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('says a new version is available for a stale chunk, with Reload', () => {
    stubReload();
    window.sessionStorage.setItem('repopulse.chunk-reload-at', String(Date.now()));
    render(<AppError error={new TypeError('Failed to fetch dynamically imported module: x')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('A new version of RepoPulse is available');
    expect(screen.getByTestId('app-error-reload')).toBeInTheDocument();
  });

  it('shows any other error with its message', () => {
    render(<AppError error={new Error('boom')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByTestId('app-error-detail')).toHaveTextContent('boom');
  });
});
