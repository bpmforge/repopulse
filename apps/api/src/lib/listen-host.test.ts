import { describe, expect, it } from 'vitest';
import { listenHost } from './listen-host.js';

// W17-37: `pnpm dev` printed "Server listening at http://192.168.13.113:13300".
// A host-run API and worker health server must bind loopback unless HOST says
// otherwise; the container images set HOST=0.0.0.0 so the compose network
// (nginx → api) still reaches them, and only the web proxy publishes a port.

describe('listen host (W17-37)', () => {
  it('defaults to loopback, not every interface', () => {
    expect(listenHost({})).toBe('127.0.0.1');
    expect(listenHost({ HOST: '' })).toBe('127.0.0.1');
  });

  it('honours an explicit HOST (the container images set 0.0.0.0)', () => {
    expect(listenHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(listenHost({ HOST: ' :: ' })).toBe('::');
  });
});
