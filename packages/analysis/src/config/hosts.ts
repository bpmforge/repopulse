import { z } from 'zod';

// SC-24 LM Studio boundary discipline (W6-08, T-20/T-21).
//
// The host list is ADMIN WORKSPACE CONFIG, never per-request input. That single
// sentence is the whole control: if a request could name the host, then anyone
// who can reach the analysis API could point this product's diff-sending
// machinery at a server they control — and diffs are the most sensitive thing
// the warehouse holds. Validation below is the second line; the first is that
// no route accepts a host.

/** RFC1918 + link-local + CGNAT + loopback-adjacent ranges. */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => Number.isNaN(n) || n > 255)) return false;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 100.64/10 is CGNAT — private in practice on the kind of LAN this runs on.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * 169.254.169.254 and friends: the cloud metadata endpoint.
 *
 * Called out separately from "public" because it is link-local, so a naive
 * private-range check would WAVE IT THROUGH — and it is the single most
 * valuable SSRF target there is, handing out instance credentials to anything
 * that can make an HTTP request from the host.
 */
function isMetadataAddress(host: string): boolean {
  return host.startsWith('169.254.');
}

export interface HostPolicy {
  /**
   * Allows a non-private host. Deliberately explicit and deliberately awkward
   * to set: a deployment that genuinely runs its model on a public host should
   * have to say so, in config, where someone reviews it.
   */
  allowPublicHosts?: boolean;
  /** Loopback is allowed by default — the common single-machine dev case. */
  allowLoopback?: boolean;
}

export class HostPolicyError extends Error {
  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(`Rejected LM Studio host ${url}: ${reason} (SC-24)`);
    this.name = 'HostPolicyError';
  }
}

/** Validates one configured base URL against SC-24. */
export function validateHostUrl(raw: string, policy: HostPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HostPolicyError(raw, 'not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HostPolicyError(raw, `scheme ${url.protocol} is not http(s)`);
  }

  const host = url.hostname;

  // Checked BEFORE the private-range test: 169.254.x is link-local, so a
  // private-range check alone would let the metadata endpoint through.
  if (isMetadataAddress(host)) {
    throw new HostPolicyError(
      raw,
      'link-local metadata address — this is an SSRF target, never a model host',
    );
  }

  if (isLoopback(host)) {
    if (policy.allowLoopback === false)
      throw new HostPolicyError(raw, 'loopback is disabled by policy');
    return url;
  }

  if (isPrivateIpv4(host)) return url;

  // Hostnames are rejected by default even though one could resolve to a
  // private address: the resolution happens later, elsewhere, and can change
  // between validation and use. A name that resolves privately today is not a
  // guarantee about tomorrow.
  if (!policy.allowPublicHosts) {
    throw new HostPolicyError(
      raw,
      'not a private-range LAN address — set allowPublicHosts explicitly if this is intended',
    );
  }
  return url;
}

export const hostConfigSchema = z.object({
  baseUrl: z.string().min(1),
  modelSlot: z.string().min(1),
});

export const t2ConfigSchema = z.object({
  hosts: z.array(hostConfigSchema).min(1),
  concurrencyCap: z.number().int().min(1).max(16).default(1),
  allowPublicHosts: z.boolean().default(false),
  allowLoopback: z.boolean().default(true),
});

export type T2HostConfig = z.infer<typeof t2ConfigSchema>;

/** Parses and validates the workspace's configured host list. */
export function parseT2Config(raw: unknown): T2HostConfig {
  const parsed = t2ConfigSchema.parse(raw);
  for (const host of parsed.hosts) {
    validateHostUrl(host.baseUrl, {
      allowPublicHosts: parsed.allowPublicHosts,
      allowLoopback: parsed.allowLoopback,
    });
  }
  return parsed;
}

/**
 * The BASE headers for a Tier-2 call — still deliberately credential-free
 * (SC-24). A LAN model needs no authorization, and this remains what a host
 * gets unless a human has said otherwise.
 *
 * Exported so the test can assert the exact set rather than trusting the client
 * not to add to it later. Frozen for the same reason.
 */
export const T2_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json',
});

/** A configured provider's credential and extra headers (W16-06). */
export interface HostAuth {
  /** The API key. Sent as `Authorization: Bearer` unless `authHeader` says otherwise. */
  apiKey?: string | undefined;
  /** Vendors that do not use bearer auth — Anthropic wants `x-api-key`. */
  authHeader?: string | undefined;
  /** Extra non-secret headers, verbatim (OpenRouter attribution, gateway routing). */
  extra?: Record<string, string> | undefined;
}

/**
 * Builds the header set for one call (W16-06, D-LLM-1).
 *
 * WHY THIS EXISTS AT ALL. The header set above was frozen and credential-free,
 * which meant Tier 2 could never authenticate — and every hosted provider
 * requires a key. Combined with the host policy rejecting non-private hosts,
 * "bring your own LLM" was impossible for anything but a LAN box, which is not
 * the product RepoPulse is meant to be (D-LLM-1).
 *
 * The strictness is not removed, it is made conditional on a stored decision: a
 * credential is attached ONLY when a human created a provider row carrying one.
 * There is still no path from a REQUEST to a header — nothing user-supplied at
 * call time can introduce one — which was always the actual control. A diff
 * cannot be redirected to an attacker's endpoint by anyone who can reach the
 * analysis API; it can only go where a stored, authored row says.
 */
export function requestHeadersFor(auth?: HostAuth): Record<string, string> {
  const headers: Record<string, string> = { ...T2_REQUEST_HEADERS };

  // Extra headers first, so a provider's own headers can never shadow the
  // credential or the content type — the two things the call cannot work
  // without.
  for (const [k, v] of Object.entries(auth?.extra ?? {})) {
    const key = k.toLowerCase();
    // Refused rather than ignored: a person putting a key in the headers bag
    // has stored a secret in a column that is not encrypted, and silently
    // dropping it would leave them believing it was sent.
    if (key === 'authorization' || key === 'x-api-key') {
      throw new HostPolicyError(
        key,
        'a credential belongs in the encrypted credential column, not in the headers bag',
      );
    }
    headers[key] = v;
  }

  if (auth?.apiKey) {
    const name = auth.authHeader?.toLowerCase() ?? 'authorization';
    headers[name] = name === 'authorization' ? `Bearer ${auth.apiKey}` : auth.apiKey;
  }

  return headers;
}

/** True when an outbound payload carries anything that looks like a secret. */
export function containsCredentialMaterial(payload: string): boolean {
  return [
    /authorization/i,
    /bearer\s+\S+/i,
    /ghp_[A-Za-z0-9]/,
    /github_pat_/i,
    /sk-[A-Za-z0-9]{10}/,
    /"?(api[_-]?key|token|secret|password)"?\s*[:=]/i,
  ].some((re) => re.test(payload));
}
