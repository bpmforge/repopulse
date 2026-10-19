// Which proxies the API believes about the client's address (W20-07, UX_TODO
// INS-55).
//
// Behind the shipped nginx every request arrived from the web container's
// address, because Fastify trusted no proxy. So the SC-11 sign-in limit (10 a
// minute) was shared by the whole install — a team signing in together, or a
// few mistyped passwords, locked EVERYONE out for a minute — and every audit
// line carried the proxy's IP instead of the person's.
//
// HOP COUNTS, VALIDATED. nginx appends the address it saw to X-Forwarded-For,
// so trusting exactly the hops that really exist reads that entry and ignores
// anything a client wrote further left. Trusting more lets any client pick its
// own address and walk past the limit. Fastify 5.12+ refuses a bare numeric
// `trustProxy` for that reason (it cannot tell a proxy from a direct client),
// so the hop count is expressed as a function that ALSO requires the nearest
// peer to be on a private network — where the compose network puts nginx.
//
//   TRUST_PROXY unset → 1      (the shipped stack: browser → nginx → api)
//   TRUST_PROXY=2              (your own TLS terminator in front of nginx)
//   TRUST_PROXY=false          (the API is reachable with no proxy in front)
//   TRUST_PROXY=10.0.0.0/8,…   (trust exactly these proxy addresses)

export type TrustProxyFn = (address: string, hop: number) => boolean;
export type TrustProxy = boolean | string | TrustProxyFn;

export const DEFAULT_TRUST_PROXY_HOPS = 1;

/** Loopback, link-local and private ranges (RFC 1918, RFC 4193), v4 and v6. */
export function isPrivateAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  if (v4) {
    const [first, second] = [Number(v4[1]), Number(v4[2])];
    return (
      first === 10 ||
      first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}

/** Trust `hops` proxies, the nearest of which must sit on a private network. */
export function trustHops(hops: number): TrustProxyFn {
  return (address, hop) => hop < hops && (hop > 0 || isPrivateAddress(address));
}

/** Parses TRUST_PROXY; returns an error message for a value it cannot use. */
export function parseTrustProxy(raw: string | undefined): TrustProxy | { error: string } {
  const value = raw?.trim();
  if (value === undefined || value === '') return trustHops(DEFAULT_TRUST_PROXY_HOPS);
  if (value === 'false' || value === '0') return false;
  // `true` trusts every hop, which lets any client choose its own address.
  // Accepted because it is a documented Fastify value, but not recommended.
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return trustHops(Number(value));
  // A comma-separated list of addresses / CIDRs / proxy-addr range names.
  // Checked for shape: an obviously wrong value should fail at boot, not
  // quietly trust nothing.
  const entries = value.split(',').map((e) => e.trim());
  const ok = entries.every(
    (e) => /^[0-9a-fA-F.:]+(\/\d+)?$/.test(e) || /^(loopback|linklocal|uniquelocal)$/.test(e),
  );
  if (ok) return entries.join(',');
  return {
    error:
      'must be a hop count (1 behind the shipped nginx), false, true, or a comma-separated list of proxy addresses/CIDRs',
  };
}
