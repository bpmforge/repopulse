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

export interface ValidateBaseUrlOptions {
  /** Exact, case-insensitive hostname allowlist - no wildcard/suffix matching. */
  allowlist: readonly string[];
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

  if (parsed.protocol !== 'https:') {
    throw new ForgeSsrfError(`scheme must be https, got ${parsed.protocol}`, url);
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === '') {
    throw new ForgeSsrfError('empty hostname', url);
  }
  if (isLocalhostLike(hostname)) {
    throw new ForgeSsrfError('localhost is never an allowed forge host', url);
  }
  // WHATWG URL keeps brackets on IPv6 hostnames (e.g. "[::1]"); net.isIP
  // needs them stripped (verified against Node's actual net.isIP behavior).
  const bareHostname =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIP(bareHostname) !== 0) {
    throw new ForgeSsrfError(
      'IP literal hosts are never allowed - use an allowlisted hostname',
      url,
    );
  }
  if (isDecimalOrOctalOrHexIpSegmentHost(hostname)) {
    throw new ForgeSsrfError('disguised IP-literal host is never allowed', url);
  }

  const allowed = opts.allowlist.some((h) => h.toLowerCase() === hostname);
  if (!allowed) {
    throw new ForgeSsrfError(`hostname "${hostname}" is not on the forge base-URL allowlist`, url);
  }
}
