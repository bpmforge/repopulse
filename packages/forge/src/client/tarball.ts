import type { ForgeTarball } from '../types.js';

// Tarball download (W8-03, C1a exception, SECURITY_SUITE.md §1.4).
//
// The archive is the ONE way whole-repo source is allowed onto this machine,
// and it comes as bytes we then extract under guard — never `git clone`, never
// a working copy, nothing persisted (validate-arch rule 6).
//
// GitHub answers /tarball/{sha} with a 302 to codeload.github.com carrying a
// short-lived signed URL. THE REDIRECT IS FOLLOWED WITHOUT THE AUTHORIZATION
// HEADER: the signature in the URL is the credential, and forwarding a forge
// token to a different host than the one the connection was scoped to is a
// credential egress this ticket has no reason to perform. A test asserts the
// second request carries no auth header.

export interface TarballDownload {
  status: number;
  bytes: Uint8Array;
}

/** Fetches redirect targets. Injected so tests never touch the network. */
export type TarballDownloader = (url: string) => Promise<TarballDownload>;

/** Hosts a redirect may point at. Anything else is refused (SC-12 in spirit). */
const DEFAULT_REDIRECT_ALLOWLIST = ['codeload.github.com', 'objects.githubusercontent.com'];

export class TarballError extends Error {
  constructor(
    message: string,
    readonly reason: 'status' | 'redirect_host' | 'empty' | 'too_large',
  ) {
    super(message);
    this.name = 'TarballError';
  }
}

export function createFetchDownloader(
  allowlist: readonly string[] = DEFAULT_REDIRECT_ALLOWLIST,
  maxBytes = 2 * 1024 * 1024 * 1024,
): TarballDownloader {
  return async (url: string) => {
    const host = new URL(url).hostname;
    if (!allowlist.includes(host)) {
      throw new TarballError(`refusing to download an archive from ${host}`, 'redirect_host');
    }
    // No Authorization header, deliberately — see the note at the top.
    const res = await fetch(url, { redirect: 'follow' });
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new TarballError(`archive exceeds ${maxBytes} bytes`, 'too_large');
    }
    return { status: res.status, bytes: buf };
  };
}

export function locationOf(headers: Record<string, string>): string | undefined {
  return headers['location'] ?? headers['Location'];
}

/** Coerces whatever the transport handed back into bytes, or undefined. */
export function bytesOf(body: unknown): Uint8Array | undefined {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  // A transport that decoded the archive as text has already corrupted it —
  // returning a re-encoded string here would produce a tar that fails to parse
  // with a confusing error a long way from the cause.
  return undefined;
}

export interface ResolveTarballArgs {
  commitSha: string;
  apiHost: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  download: TarballDownloader;
  allowlist?: readonly string[];
}

/**
 * Turns one archive response into bytes, following a redirect if there is one.
 *
 * Both shapes are handled because both happen: a transport with automatic
 * redirect following returns 200 and the bytes, one with manual redirects
 * returns 302 and a Location. Branching on the status rather than assuming
 * either means the provider works under both.
 */
export async function resolveTarball(args: ResolveTarballArgs): Promise<ForgeTarball> {
  const { status, headers, body, commitSha, download } = args;

  if (status === 200) {
    const bytes = bytesOf(body);
    if (!bytes || bytes.byteLength === 0) {
      throw new TarballError('archive response carried no bytes', 'empty');
    }
    return { commitSha, bytes, sourceHost: args.apiHost };
  }

  if (status === 301 || status === 302 || status === 307) {
    const location = locationOf(headers);
    if (!location) throw new TarballError(`archive ${status} with no Location`, 'status');
    const host = new URL(location).hostname;
    const allowlist = args.allowlist ?? DEFAULT_REDIRECT_ALLOWLIST;
    if (!allowlist.includes(host)) {
      throw new TarballError(`archive redirected to unexpected host ${host}`, 'redirect_host');
    }
    const res = await download(location);
    if (res.status !== 200) {
      throw new TarballError(`archive download returned ${res.status}`, 'status');
    }
    if (res.bytes.byteLength === 0) throw new TarballError('archive was empty', 'empty');
    return { commitSha, bytes: res.bytes, sourceHost: host };
  }

  throw new TarballError(`archive request returned ${status}`, 'status');
}
