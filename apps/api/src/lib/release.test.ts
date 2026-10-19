import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { appVersion, diskSpace, diskState, formatBytes } from './release.js';

// W20-10 (UX_TODO ADM-13, ADM-44): which release this is, and disk headroom.
const GiB = 1024 ** 3;

describe('appVersion', () => {
  it('prefers the release tag', () => {
    expect(appVersion({ REPOPULSE_VERSION: ' v1.4.0 ' })).toBe('v1.4.0');
  });
  it('falls back to the package version', () => {
    expect(appVersion({})).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('diskState', () => {
  it('is ready with room', () => {
    expect(diskState({ path: '/', freeBytes: 50 * GiB, totalBytes: 100 * GiB })).toBe('ready');
  });
  it('degrades under 10% or 5 GiB', () => {
    expect(diskState({ path: '/', freeBytes: 8 * GiB, totalBytes: 100 * GiB })).toBe('degraded');
    expect(diskState({ path: '/', freeBytes: 4 * GiB, totalBytes: 10 * GiB })).toBe('degraded');
  });
  it('is unavailable under 3% or 1 GiB', () => {
    expect(diskState({ path: '/', freeBytes: 2 * GiB, totalBytes: 100 * GiB })).toBe('unavailable');
    expect(diskState({ path: '/', freeBytes: 0.5 * GiB, totalBytes: 1 * GiB })).toBe('unavailable');
    expect(diskState({ path: '/', freeBytes: 0, totalBytes: 0 })).toBe('unavailable');
  });
});

describe('diskSpace', () => {
  it('reads a real filesystem', async () => {
    const d = await diskSpace(tmpdir());
    expect(d?.totalBytes).toBeGreaterThan(0);
  });
  it('is null for a path that does not exist', async () => {
    expect(await diskSpace('/no/such/path/w20-10')).toBeNull();
  });
});

describe('formatBytes', () => {
  it('uses GiB above a gibibyte, MiB below', () => {
    expect(formatBytes(3 * GiB)).toBe('3.0 GiB');
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MiB');
  });
});
