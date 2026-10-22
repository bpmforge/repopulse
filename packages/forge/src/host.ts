// The host a forge connection talks to, as a person would say it (W20-15, X-18).
//
// Lives in packages/forge because it is forge knowledge: which API hostname is
// really which product (api.github.com is how GitHub's API is addressed, not what
// people call it), and what an absent base URL means for each provider. The ingest
// status code and the repositories route only ask; the arch rule that keeps
// `api.github.com` inside this package is why it is not written there.

export function connectionHost(provider: string, baseUrl: string | null): string | null {
  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname;
      return host === 'api.github.com' ? 'github.com' : host;
    } catch {
      return null;
    }
  }
  if (provider === 'github') return 'github.com';
  if (provider === 'gitlab') return 'gitlab.com';
  return null;
}
