// Base-image upgrade suggestions (W18-34).
//
// Pure tag arithmetic. Given the tags a registry lists for a repository, pick
// the few worth scanning as upgrade candidates: newer than the one in use and
// of the SAME VARIANT (`20-alpine` → `22-alpine`, never `22-slim`), because a
// suggestion that silently swaps the OS is a migration, not an upgrade.
// Whether a candidate actually clears findings is established by scanning it,
// not guessed here.

export interface ParsedTag {
  numbers: number[];
  /** Everything after the version, e.g. `-alpine3.19`. Two tags are comparable only when equal. */
  variant: string;
}

export function parseTag(tag: string): ParsedTag | null {
  const match = /^v?(\d+(?:\.\d+){0,3})(.*)$/.exec(tag);
  if (!match) return null;
  return { numbers: match[1]!.split('.').map(Number), variant: match[2] ?? '' };
}

function compareNumbers(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Up to `limit` newer same-variant tags, nearest first.
 *
 * Pre-release tags (`rc`, `beta`, `alpha`) are dropped: they match the variant
 * pattern only when the variant text contains them, which a stable variant
 * never does.
 */
export function upgradeCandidates(current: string, available: readonly string[], limit = 3): string[] {
  const now = parseTag(current);
  if (!now) return [];
  const newer = available
    .map((tag) => ({ tag, parsed: parseTag(tag) }))
    .filter(
      (entry): entry is { tag: string; parsed: ParsedTag } =>
        entry.parsed !== null &&
        entry.parsed.variant === now.variant &&
        !/rc|beta|alpha|dev|nightly/i.test(entry.parsed.variant) &&
        compareNumbers(entry.parsed.numbers, now.numbers) > 0,
    )
    .sort((a, b) => compareNumbers(a.parsed.numbers, b.parsed.numbers));
  // Nearest first, but spread: the closest patch release, then the latest in the
  // series, so a suggestion can say "stay on 20.x" or "move to 22".
  const picked: string[] = [];
  const add = (tag: string | undefined): void => {
    if (tag && !picked.includes(tag)) picked.push(tag);
  };
  add(newer[0]?.tag);
  const sameMajor = newer.filter((e) => e.parsed.numbers[0] === now.numbers[0]);
  add(sameMajor[sameMajor.length - 1]?.tag);
  add(newer[newer.length - 1]?.tag);
  return picked.slice(0, limit);
}

export interface CandidateScan {
  tag: string;
  /** Findings at severity >= the threshold; null when the candidate could not be scanned. */
  findings: number | null;
}

/** The suggestion text, or null when no candidate does better than the current tag. */
export function upgradeSuggestion(
  imageRepository: string,
  currentTag: string,
  currentFindings: number,
  candidates: readonly CandidateScan[],
): string | null {
  if (currentFindings === 0) return null;
  const scanned = candidates.filter(
    (c): c is { tag: string; findings: number } => c.findings !== null && c.findings < currentFindings,
  );
  if (scanned.length === 0) return null;
  const best = [...scanned].sort((a, b) => a.findings - b.findings)[0]!;
  return best.findings === 0
    ? `Moving ${imageRepository}:${currentTag} to ${best.tag} clears all ${currentFindings} findings.`
    : `Moving ${imageRepository}:${currentTag} to ${best.tag} cuts findings from ${currentFindings} to ${best.findings}.`;
}
