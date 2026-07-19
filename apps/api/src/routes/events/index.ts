import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { syncEventsChannel, type SyncStreamEvent } from '@repopulse/ingest';
import { sendProblem } from '../../lib/problem.js';

// SSE stream (API_DESIGN §3, NFR-10). One session-authed text/event-stream
// endpoint per client; a dedicated Redis subscriber relays the client's
// workspace channel (worker→api transport, ARCHITECTURE §4b). SSE is an
// optimization — correctness lives in GET /sync/status — so a dropped frame
// just means a slightly staler dashboard.

export interface EventsRoutesOptions {
  redisUrl: string;
}

/** Format one SSE frame. Pure — the wire format is `event:`/`data:` lines. */
export function formatSseFrame(event: SyncStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const HEARTBEAT_MS = 25_000;

export default async function eventsRoutes(
  app: FastifyInstance,
  opts: EventsRoutesOptions,
): Promise<void> {
  app.get('/events', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) {
      sendProblem(request, reply, 401, 'No active session');
      return reply;
    }

    // Take over the socket — Fastify won't manage this response.
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');

    const sub = new Redis(opts.redisUrl);
    const channel = syncEventsChannel(workspaceId);
    await sub.subscribe(channel);
    sub.on('message', (_ch, message) => {
      try {
        const event = JSON.parse(message) as SyncStreamEvent;
        reply.raw.write(formatSseFrame(event));
      } catch {
        // ignore a malformed frame rather than kill the stream
      }
    });

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      void sub.quit().catch(() => {});
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
