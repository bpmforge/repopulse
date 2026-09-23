import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import type { Registry } from 'prom-client';
import type { Database } from '@repopulse/shared';
import { startWorkerHealthServer } from './health.js';

// W17-37: server.listen(port) with no host binds every interface, so a
// host-run worker exposed /healthz and /metrics to the LAN.
describe('worker health server bind (W17-37)', () => {
  it('the worker health server binds the host it is given, loopback by default', async () => {
    const server = startWorkerHealthServer({
      db: {} as Database,
      redis: {} as Redis,
      registry: {} as Registry,
      port: 0,
    });
    await new Promise<void>((r) => server.once('listening', () => r()));
    try {
      expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
