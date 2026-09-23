/**
 * The interface the API and the worker health server bind (W17-37).
 *
 * Loopback unless HOST says otherwise. Binding every interface was the old
 * default, and on a laptop that put the dev API and the worker's /metrics on
 * the LAN ("Server listening at http://192.168.13.113:13300"). The container
 * images set HOST=0.0.0.0 (Dockerfile) because inside a compose network the
 * web proxy reaches the api by service name; the host still sees only the
 * web port, published on REPOPULSE_BIND (default 127.0.0.1).
 */
export function listenHost(env: Record<string, string | undefined> = process.env): string {
  const host = env.HOST?.trim();
  return host ? host : '127.0.0.1';
}
