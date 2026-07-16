import { isEligibleForChurn } from '../engine/exclusions.js';
import { windowStart } from '../engine/windows.js';
import { ratio } from '../engine/ratio.js';

// METRICS.md §1 M3: fixed trailing 365d (not the configurable §0 window).
const OWNERSHIP_WINDOW_DAYS = 365;
const SINGLE_OWNER_THRESHOLD = 0.8;
const BUS_FACTOR_COVERAGE_THRESHOLD = 0.5;

export interface OwnershipTouch {
  authorLogin: string;
  path: string;
  additions: number;
  deletions: number;
  touchedAt: string; // ISO
  parentShaCount: number;
  superseded: boolean;
}

export interface OwnershipResult {
  totalLinesChanged: number;
  linesChangedByAuthor: Record<string, number>;
  /** null when there is no eligible activity at all ("no data", never 0). */
  topShare: number | null;
  busFactor: number;
  singleOwner: boolean;
}

function isWithinTrailingWindow(touchedAt: string, asOf: Date): boolean {
  const start = windowStart(asOf, OWNERSHIP_WINDOW_DAYS);
  const touched = new Date(touchedAt);
  return touched >= start && touched <= asOf;
}

/** METRICS.md §1 M3: linesChanged/topShare/busFactor/single_owner over eligible touches in the trailing 365d. */
export function computeOwnership(
  touches: readonly OwnershipTouch[],
  asOf: Date,
  botGlobs?: readonly string[],
): OwnershipResult {
  const eligible = touches.filter(
    (t) =>
      isWithinTrailingWindow(t.touchedAt, asOf) &&
      isEligibleForChurn(
        { authorLogin: t.authorLogin, parentShaCount: t.parentShaCount, superseded: t.superseded },
        botGlobs,
      ),
  );

  const linesChangedByAuthor = new Map<string, number>();
  for (const t of eligible) {
    const lines = t.additions + t.deletions;
    linesChangedByAuthor.set(t.authorLogin, (linesChangedByAuthor.get(t.authorLogin) ?? 0) + lines);
  }

  const total = [...linesChangedByAuthor.values()].reduce((sum, n) => sum + n, 0);
  const sortedDesc = [...linesChangedByAuthor.entries()].sort((a, b) => b[1] - a[1]);

  const topShare = sortedDesc.length === 0 ? null : ratio(sortedDesc[0]![1], total).value;

  let busFactor = 0;
  let cumulative = 0;
  for (const [, lines] of sortedDesc) {
    busFactor++;
    cumulative += lines;
    if (cumulative / total >= BUS_FACTOR_COVERAGE_THRESHOLD) break;
  }

  return {
    totalLinesChanged: total,
    linesChangedByAuthor: Object.fromEntries(linesChangedByAuthor),
    topShare,
    busFactor,
    singleOwner: (topShare ?? 0) >= SINGLE_OWNER_THRESHOLD,
  };
}

/** file grain. */
export function computeFileOwnership(
  touches: readonly OwnershipTouch[],
  path: string,
  asOf: Date,
  botGlobs?: readonly string[],
): OwnershipResult {
  return computeOwnership(
    touches.filter((t) => t.path === path),
    asOf,
    botGlobs,
  );
}

/** directory grain: recursive sum of every file under dirPath (METRICS.md §1 M3). */
export function computeDirectoryOwnership(
  touches: readonly OwnershipTouch[],
  dirPath: string,
  asOf: Date,
  botGlobs?: readonly string[],
): OwnershipResult {
  const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
  return computeOwnership(
    touches.filter((t) => t.path.startsWith(prefix)),
    asOf,
    botGlobs,
  );
}
