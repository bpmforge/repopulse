import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePackageName, SLOPSQUAT_ECOSYSTEMS, type SlopEcosystem } from './names.js';

// Popular-package lists: what a typosquat imitates (W21-05).
//
// SHIPPED, NOT SYNCED. They live in rulepacks/slopsquat/popular/<eco>.txt,
// data beside the other packs, each with its source and fetch date in the
// header (refreshed per release from those sources), because a near-miss
// check must work on an install that never ran the sync (the near-miss half
// needs no registry at all). An
// operator who wants fresher lists drops `popular-<eco>.txt` files of the same
// shape into the package-index directory and they replace the shipped ones.
//
// TWO USES OF ONE RANKED LIST:
//   targets — the first TARGET_COUNT names. Typosquats imitate the very top of
//             a registry (that is where the installs are), and every extra
//             target is another real package some legitimate long-tail name
//             sits one edit from.
//   known   — every name in the file. A name in it is never flagged: being
//             the 4,000th most-downloaded npm package is evidence of being
//             real that no edit distance outweighs.

export const POPULAR_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../rulepacks/slopsquat/popular',
);

const TARGET_COUNT: Record<SlopEcosystem, number> = {
  npm: 3000,
  pypi: 3000,
  cargo: 1000,
  rubygems: 500,
  go: 500,
  maven: 500,
};

export interface PopularList {
  ecosystem: SlopEcosystem;
  /** Normalised names, rank order. */
  targets: readonly string[];
  /** Rank (0-based) by normalised name, over the whole file. */
  rank: ReadonlyMap<string, number>;
  /** Where the list came from: the file's header comment. */
  source: string;
}

export type PopularLists = Record<SlopEcosystem, PopularList>;

export function parsePopular(ecosystem: SlopEcosystem, text: string): PopularList {
  const names: string[] = [];
  const header: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      header.push(line.replace(/^#\s*/, ''));
      continue;
    }
    names.push(normalizePackageName(ecosystem, line));
  }
  const rank = new Map<string, number>();
  names.forEach((n, i) => {
    if (!rank.has(n)) rank.set(n, i);
  });
  return {
    ecosystem,
    targets: names.slice(0, TARGET_COUNT[ecosystem]),
    rank,
    source: header.join(' ') || 'unstated',
  };
}

let shipped: PopularLists | undefined;

/** The lists in use: an override from the index directory wins per ecosystem. */
export function loadPopular(indexDir?: string): PopularLists {
  const out = {} as PopularLists;
  for (const eco of SLOPSQUAT_ECOSYSTEMS) {
    const override = indexDir ? path.join(indexDir, `popular-${eco}.txt`) : null;
    if (override && existsSync(override)) {
      try {
        out[eco] = parsePopular(eco, readFileSync(override, 'utf8'));
        continue;
      } catch {
        // Unreadable override: the shipped list still answers.
      }
    }
    shipped ??= {} as PopularLists;
    shipped[eco] ??= parsePopular(eco, readFileSync(path.join(POPULAR_DIR, `${eco}.txt`), 'utf8'));
    out[eco] = shipped[eco];
  }
  return out;
}
