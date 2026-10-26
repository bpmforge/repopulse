import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { normalizePackageName, SLOPSQUAT_ECOSYSTEMS, type SlopEcosystem } from './names.js';

// The offline package-name index (W21-05).
//
// "Does this package exist?" is a registry question, and the scan path has no
// network: the sandbox runs --network=none and the worker makes no registry
// calls at scan time. So, like the grype database and the malicious-package
// index, the answer is fetched HOST-SIDE by deploy/scan-db-sync.sh (through
// deploy/build-package-index.py, in the scan image) into
// $SCAN_RULES_DIR/package-index, mounted read-only, and read here.
//
// ON DISK:
//   manifest.json   {"version":1,"generated":ISO,"ecosystems":{"npm":{"file":"npm.tsv",
//                    "count":N,"source":"...","generated":ISO,"metadata":false}, ...}}
//   <eco>.tsv       one package per line, sorted by UTF-8 bytes, already normalised
//                   (names.ts rules): `name` or `name<TAB>created ISO<TAB>downloads`,
//                   either metadata field may be empty.
//
// LOOKUP is a binary search over the file's bytes with a line-offset table, not
// a Set: npm alone is ~4.6M names, and a Set of them is ~400 MB of heap for a
// question asked a few dozen times per scan. The buffer plus offsets is the
// file size plus 4 bytes a name, loaded once per process and per file mtime.
//
// AN ABSENT ECOSYSTEM IS "NOT CHECKED", never "not found". A missing index
// that read as "nothing exists" would file every dependency as hallucinated;
// one that read as "everything exists" would hide every hallucination. Both are
// the silent-clean failure the rest of this package refuses.

export interface PackageMeta {
  /** First publication, ISO 8601, when the source records it. */
  created: string | null;
  /** All-time downloads, when the source records them. */
  downloads: number | null;
}

export interface EcosystemIndex {
  ecosystem: SlopEcosystem;
  count: number;
  source: string;
  generated: string;
  /** True when lines carry created/downloads (crates.io, Go first-seen). */
  metadata: boolean;
  has(name: string): boolean;
  /** Any package whose normalised name starts with this (npm scopes). */
  hasPrefix(prefix: string): boolean;
  meta(name: string): PackageMeta | null;
}

export interface PackageIndex {
  dir: string;
  generated: string | null;
  ecosystems: Partial<Record<SlopEcosystem, EcosystemIndex>>;
  /** Per ecosystem, why it is not checked — stated on the run. */
  missing: Partial<Record<SlopEcosystem, string>>;
}

export function packageIndexDir(): string {
  return path.join(process.env.SCAN_RULES_DIR ?? '/var/lib/repopulse/scan-rules', 'package-index');
}

interface ManifestEntry {
  file?: unknown;
  count?: unknown;
  source?: unknown;
  generated?: unknown;
  metadata?: unknown;
  /** Go's incremental backfill: false until it has caught up. */
  complete?: unknown;
}

const cache = new Map<string, { mtimeMs: number; index: EcosystemIndex }>();

/** Reads the index directory. Never throws: a broken index is "not checked". */
export function loadPackageIndex(dir: string = packageIndexDir()): PackageIndex {
  const out: PackageIndex = { dir, generated: null, ecosystems: {}, missing: {} };
  const notSynced = (why: string): PackageIndex => {
    for (const eco of SLOPSQUAT_ECOSYSTEMS) out.missing[eco] = why;
    return out;
  };
  const manifestPath = path.join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return notSynced('no package-name index is synced here (run deploy/scan-db-sync.sh)');
  }
  let manifest: { generated?: unknown; ecosystems?: Record<string, ManifestEntry> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
  } catch (error) {
    return notSynced(
      `the package-name index manifest could not be read (${(error as Error).message.slice(0, 80)})`,
    );
  }
  out.generated = typeof manifest.generated === 'string' ? manifest.generated : null;
  const entries = manifest.ecosystems ?? {};
  for (const eco of SLOPSQUAT_ECOSYSTEMS) {
    const entry = entries[eco];
    if (!entry || typeof entry.file !== 'string') {
      out.missing[eco] = `the package-name index has no ${eco} list`;
      continue;
    }
    // A PARTIAL list cannot answer "does it exist": every module the backfill
    // has not reached yet would read as missing.
    if (entry.complete === false) {
      out.missing[eco] =
        `the ${eco} name list is still backfilling (as of ${typeof entry.generated === 'string' ? entry.generated.slice(0, 10) : '?'})`;
      continue;
    }
    // A manifest naming a file outside its own directory is refused.
    const file = path.join(dir, path.basename(entry.file));
    try {
      out.ecosystems[eco] = openEcosystem(eco, file, entry);
    } catch (error) {
      out.missing[eco] =
        `the ${eco} name list could not be read (${(error as Error).message.slice(0, 80)})`;
    }
  }
  return out;
}

function openEcosystem(eco: SlopEcosystem, file: string, entry: ManifestEntry): EcosystemIndex {
  const mtimeMs = statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.index;
  const index = sortedLineIndex(eco, readFileSync(file), {
    count: typeof entry.count === 'number' ? entry.count : 0,
    source: typeof entry.source === 'string' ? entry.source : 'unknown',
    generated: typeof entry.generated === 'string' ? entry.generated : 'unknown',
    metadata: entry.metadata === true,
  });
  cache.set(file, { mtimeMs, index });
  return index;
}

/**
 * Builds the lookup over one sorted name file. Exported for tests and for the
 * fixture index the precision/recall test builds in memory.
 */
export function sortedLineIndex(
  ecosystem: SlopEcosystem,
  buffer: Buffer,
  info: { count: number; source: string; generated: string; metadata: boolean },
): EcosystemIndex {
  // Line starts, the end of each line's NAME (first tab) and of the line.
  // Typed arrays sized by a first counting pass: npm is millions of lines,
  // and three growing number[]s of that length cost more than the file.
  let capacity = 1;
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === 0x0a) capacity += 1;
  const startArr = new Uint32Array(capacity);
  const nameEndArr = new Uint32Array(capacity);
  const lineEndArr = new Uint32Array(capacity);
  let count = 0;
  let start = 0;
  let nameEnd = -1;
  for (let i = 0; i <= buffer.length; i += 1) {
    const byte = i < buffer.length ? buffer[i] : 0x0a;
    if (byte === 0x09 && nameEnd === -1) nameEnd = i;
    if (byte === 0x0a) {
      let end = i;
      if (end > start && buffer[end - 1] === 0x0d) end -= 1;
      if (end > start) {
        startArr[count] = start;
        nameEndArr[count] = nameEnd === -1 ? end : Math.min(nameEnd, end);
        lineEndArr[count] = end;
        count += 1;
      }
      start = i + 1;
      nameEnd = -1;
    }
  }
  const n = count;

  const compareAt = (i: number, target: Buffer, prefixOnly: boolean): number => {
    const s = startArr[i]!;
    const e = nameEndArr[i]!;
    const len = e - s;
    if (prefixOnly && len >= target.length) {
      return buffer.compare(target, 0, target.length, s, s + target.length);
    }
    return buffer.compare(target, 0, target.length, s, e);
  };

  /** First line whose name is >= target. */
  const lowerBound = (target: Buffer): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareAt(mid, target, false) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const find = (name: string): number => {
    const target = Buffer.from(normalizePackageName(ecosystem, name), 'utf8');
    const at = lowerBound(target);
    return at < n && compareAt(at, target, false) === 0 ? at : -1;
  };

  return {
    ecosystem,
    count: info.count || n,
    source: info.source,
    generated: info.generated,
    metadata: info.metadata,
    has: (name) => find(name) !== -1,
    hasPrefix: (prefix) => {
      const target = Buffer.from(normalizePackageName(ecosystem, prefix), 'utf8');
      const at = lowerBound(target);
      return at < n && compareAt(at, target, true) === 0;
    },
    meta: (name) => {
      const at = find(name);
      if (at === -1) return null;
      const line = buffer.toString('utf8', startArr[at]!, lineEndArr[at]!);
      const [, created, downloads] = line.split('\t');
      const parsed = downloads !== undefined && downloads !== '' ? Number(downloads) : NaN;
      return {
        created: created ? created : null,
        downloads: Number.isFinite(parsed) ? parsed : null,
      };
    },
  };
}

/** An index built from a list of lines, for tests and fixtures. */
export function indexFromLines(
  ecosystem: SlopEcosystem,
  lines: readonly string[],
  info: Partial<{ source: string; generated: string; metadata: boolean }> = {},
): EcosystemIndex {
  const normalized = lines
    .map((line) => {
      const [name, ...rest] = line.split('\t');
      return [normalizePackageName(ecosystem, name!), ...rest].join('\t');
    })
    .sort((a, b) => Buffer.compare(Buffer.from(a.split('\t')[0]!), Buffer.from(b.split('\t')[0]!)));
  return sortedLineIndex(ecosystem, Buffer.from(normalized.join('\n') + '\n', 'utf8'), {
    count: normalized.length,
    source: info.source ?? 'fixture',
    generated: info.generated ?? 'fixture',
    metadata: info.metadata ?? lines.some((l) => l.includes('\t')),
  });
}
