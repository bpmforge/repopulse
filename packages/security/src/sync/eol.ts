import { sql } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';
import type { JsonFetcher } from './fetch-json.js';

// eol_products db-sync (W10-02, DATABASE.md D13, FR-REG-3).
//
// Source: endoflife.date, API v1 — verified live on 2026-08-19 (Law 2),
// schema_version 1.2.1. The legacy `/api/<product>.json` shape still answers
// but v1 is the documented current one, and its field names differ:
//
//   GET https://endoflife.date/api/v1/products/<product>
//     result.releases[].name         -> cycle
//     result.releases[].eolFrom      -> eol_date        (null = no date set)
//     result.releases[].eoasFrom     -> support_until   (end of active support)
//     result.releases[].latest.name  -> latest_version
//
// ATTRIBUTION: endoflife.date is MIT-licensed (their README). We name it as
// the source wherever an EOL finding is rendered — see EOL_ATTRIBUTION.

export const EOL_ATTRIBUTION = 'EOL dates from endoflife.date (MIT)';
export const EOL_API_BASE = 'https://endoflife.date/api/v1/products';

export interface EolCycle {
  product: string;
  cycle: string;
  eolDate: Date | null;
  supportUntil: Date | null;
  latestVersion: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

function asDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseEolProduct(product: string, body: unknown): EolCycle[] {
  const releases = asRecord(asRecord(body)['result'])['releases'];
  if (!Array.isArray(releases)) return [];

  return releases.flatMap((entry) => {
    const release = asRecord(entry);
    const cycle = release['name'];
    if (typeof cycle !== 'string') return [];
    return [
      {
        product,
        cycle,
        eolDate: asDate(release['eolFrom']),
        supportUntil: asDate(release['eoasFrom']),
        latestVersion: (() => {
          const latest = asRecord(release['latest'])['name'];
          return typeof latest === 'string' ? latest : null;
        })(),
      },
    ];
  });
}

export interface SyncEolDeps {
  db: Database;
  fetchJson: JsonFetcher;
  /** Products to track — the runtimes and base images our repos actually use. */
  products: readonly string[];
}

export interface SyncEolResult {
  requested: number;
  cycles: number;
  failed: { product: string; reason: string }[];
}

export async function syncEolProducts(deps: SyncEolDeps): Promise<SyncEolResult> {
  const result: SyncEolResult = { requested: deps.products.length, cycles: 0, failed: [] };

  for (const product of deps.products) {
    let cycles: EolCycle[];
    try {
      cycles = parseEolProduct(product, await deps.fetchJson(`${EOL_API_BASE}/${product}`));
    } catch (error) {
      result.failed.push({
        product,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const cycle of cycles) {
      await deps.db
        .insert(security.eolProducts)
        .values({
          product: cycle.product,
          cycle: cycle.cycle,
          eolDate: cycle.eolDate,
          supportUntil: cycle.supportUntil,
          latestVersion: cycle.latestVersion,
          fetchedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [security.eolProducts.product, security.eolProducts.cycle],
          set: {
            eolDate: sql`excluded.eol_date`,
            supportUntil: sql`excluded.support_until`,
            latestVersion: sql`excluded.latest_version`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
      result.cycles += 1;
    }
  }

  return result;
}
