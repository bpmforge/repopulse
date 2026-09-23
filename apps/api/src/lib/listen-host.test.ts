import { describe, expect, it } from 'vitest';
import { listenHost } from './listen-host.js';

// W17-37: `pnpm dev` printed "Server listening at http://192.168.13.113:13300".
// A host-run API and worker health server must bind loopback unless
// LISTEN_HOST says otherwise; the container images set LISTEN_HOST=0.0.0.0 so
// the compose network (nginx → api) still reaches them, and only the web proxy
// publishes a port.

describe('listen host (W17-37)', () => {
  it('defaults to loopback, not every interface', () => {
    expect(listenHost({})).toBe('127.0.0.1');
    expect(listenHost({ LISTEN_HOST: '' })).toBe('127.0.0.1');
  });

  it('honours an explicit LISTEN_HOST (the container images set 0.0.0.0)', () => {
    expect(listenHost({ LISTEN_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(listenHost({ LISTEN_HOST: ' :: ' })).toBe('::');
  });

  // Verifier finding: HOST is a generic name — zsh sets it to the machine's
  // hostname, and some shells and CI runners EXPORT it. Reading it would bind
  // whatever interface that hostname resolves to, i.e. the LAN, which is the
  // exact exposure this default exists to prevent.
  it('ignores a generic HOST (a shell or CI hostname), staying on loopback', () => {
    expect(listenHost({ HOST: 'build-box.lan' })).toBe('127.0.0.1');
    expect(listenHost({ HOST: '0.0.0.0' })).toBe('127.0.0.1');
  });
});
