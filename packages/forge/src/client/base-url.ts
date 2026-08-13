// SC-12 forge base-URL allowlist (SSRF). Ships in W1 so the GitHubProvider
// ticket (W1-06) inherits rather than reinvents (SECURITY_CONTROLS.md SC-12).
//
// Scope note: this module only covers the string-level checks that don't
// require an actual network resolution - scheme, hostname-shape, and
// allowlist membership. The "resolve-then-pin the IP" rebinding defense
// (SC-12) needs a concrete request executor with DNS control and belongs
// with whichever transport W1-06/W7-02 wire up; it is out of scope here.
import { isIP } from 'node:net';

export class ForgeSsrfError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'ForgeSsrfError';
  }
}

function isDecimalOrOctalOrHexIpSegmentHost(hostname: string): boolean {
  // inet_aton-style disguises: pure decimal ("2852039166"), or dotted forms
  // with octal (leading zero) or hex (0x) segments that browsers/curl still
  // resolve as IPv4. A legitimate allowlisted hostname is never shaped like
  // this, so any match here is rejected outright.
  if (/^\d+$/.test(hostname)) return true; // pure decimal / octal-as-decimal
  const parts = hostname.split('.');
  if (parts.length >= 2 && parts.length <= 4) {
    return parts.every((p) => /^(0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(p));
  }
  return false;
}

function isLocalhostLike(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

/**
 * Exact loopback only: `localhost`, `::1`, or 127.0.0.0/8 in canonical dotted
 * form. Deliberately NOT `*.localhost` (the DNS-rebinding stub pattern) and
 * NOT the inet_aton disguises - those stay rejected even under the escape
 * hatch below, because a host that needs disguising is never a local fixture.
 */
function isLoopbackHost(bareHostname: string): boolean {
  if (bareHostname === 'localhost' || bareHostname === '::1') return true;
  return isIP(bareHostname) === 4 && bareHostname.startsWith('127.');
}

export interface ValidateBaseUrlOptions {
  /** Exact, case-insensitive hostname allowlist - no wildcard/suffix matching. */
  allowlist: readonly string[];
  /**
   * Operator-only escape hatch: permit `http://` on an exact loopback host.
   *
   * SC-12's threat model is an ATTACKER-controlled base URL. The forge base URL
   * is not user input anywhere in the product - it comes from the operator's
   * `FORGE_BASE_URL` env at the composition root (apps/api/src/index.ts,
   * workers/index.ts) and no route or UI accepts one. An operator who can set
   * that env already has arbitrary-URL power, so a loopback relaxation they
   * opt into grants nothing they did not already have.
   *
   * It exists so the e2e fake forge (http://127.0.0.1:PORT) can exercise the
   * real ingestion path. It is NOT a license for plain-http forges in general:
   * the host must still be loopback AND still be on the allowlist. A
   * self-hosted forge on a LAN over http is a separate posture decision and is
   * still rejected here.
   */
  allowInsecureLoopback?: boolean;
}

/**
 * Throws ForgeSsrfError if `url` is not an allowed forge base URL. Never
 * returns a boolean - callers must not treat a missing throw as optional.
 */
export function validateBaseUrl(url: string, opts: ValidateBaseUrlOptions): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ForgeSsrfError('not a valid URL', url);
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === '') {
    throw new ForgeSsrfError('empty hostname', url);
  }

  // WHATWG URL keeps brackets on IPv6 hostnames (e.g. "[::1]"); net.isIP
  // needs them stripped (verified against Node's actual net.isIP behavior).
  const bareHostname =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  // Resolved once, before any check, so the scheme and host-shape rules relax
  // together or not at all - a half-applied escape hatch is worse than none.
  const loopbackEscape = opts.allowInsecureLoopback === true && isLoopbackHost(bareHostname);

  if (parsed.protocol !== 'https:' && !(loopbackEscape && parsed.protocol === 'http:')) {
    throw new ForgeSsrfError(`scheme must be https, got ${parsed.protocol}`, url);
  }

  if (!loopbackEscape) {
    if (isLocalhostLike(hostname)) {
      throw new ForgeSsrfError('localhost is never an allowed forge host', url);
    }
    if (isIP(bareHostname) !== 0) {
      throw new ForgeSsrfError(
        'IP literal hosts are never allowed - use an allowlisted hostname',
        url,
      );
    }
    if (isDecimalOrOctalOrHexIpSegmentHost(hostname)) {
      throw new ForgeSsrfError('disguised IP-literal host is never allowed', url);
    }
  }

  // Allowlist membership is never relaxed, escape hatch or not.
  //
  // Compared against the BRACKET-STRIPPED host, with entries stripped too, so
  // an IPv6 allowlist entry written the natural way ("::1") matches the
  // URL.hostname WHATWG hands back ("[::1]"). Same failure shape as deriving
  // the entry from URL.host: the two sides must be spelled identically or the
  // match silently never fires.
  const stripBrackets = (h: string): string =>
    h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  const allowed = opts.allowlist.some((h) => stripBrackets(h.toLowerCase()) === bareHostname);
  if (!allowed) {
    throw new ForgeSsrfError(`hostname "${hostname}" is not on the forge base-URL allowlist`, url);
  }
}
