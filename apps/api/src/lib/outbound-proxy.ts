// What the api and worker say at startup about an outbound proxy (W20-10,
// UX_TODO INS-63).
//
// Node's built-in fetch, which every forge, tarball, model and OIDC call goes
// through, IGNORES HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set when the
// process starts (verified on Node 22.23: with it a CONNECT reaches the proxy,
// without it the request goes direct). The shipped compose file sets it; a
// hand-run process may not, and then the proxy is silently ignored and the
// first symptom is a forge connection timing out. So say so at boot.

export interface ProxyNotice {
  level: 'info' | 'warn';
  message: string;
}

function first(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** The proxy URL with any user:password removed — this goes to the log. */
export function redactProxyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '(unparseable proxy URL)';
  }
}

export function outboundProxyNotice(env: Record<string, string | undefined>): ProxyNotice | null {
  const proxy = first(env, 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy');
  if (proxy === undefined) return null;
  if (env.NODE_USE_ENV_PROXY !== '1') {
    return {
      level: 'warn',
      message: `An outbound proxy is set (${redactProxyUrl(proxy)}) but NODE_USE_ENV_PROXY is not 1, so Node's fetch ignores it and connects directly. Set NODE_USE_ENV_PROXY=1 (the shipped compose file does). See docs/INSTALL.md → Outbound proxy.`,
    };
  }
  const noProxy = first(env, 'NO_PROXY', 'no_proxy') ?? '(none)';
  return {
    level: 'info',
    message: `Outbound calls go through ${redactProxyUrl(proxy)}; direct for: ${noProxy}.`,
  };
}
