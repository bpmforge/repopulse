// GitHub REST pagination: the opaque ForgeCursor is just the next page number,
// parsed from the RFC 5988 Link header's rel="next" entry (research §3).
export function nextPageCursor(linkHeader: string | undefined): string | undefined {
  if (!linkHeader) return undefined;
  const nextPart = linkHeader.split(',').find((p) => /rel="next"/.test(p));
  const url = nextPart?.match(/<([^>]+)>/)?.[1];
  if (!url) return undefined;
  return new URL(url).searchParams.get('page') ?? undefined;
}

// Read the (possibly differently-cased) Link header off a response.
export function linkHeaderOf(headers: Record<string, string>): string | undefined {
  return headers['link'] ?? headers['Link'];
}
