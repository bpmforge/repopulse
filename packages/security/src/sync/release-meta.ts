import { sql } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';
import type { JsonFetcher } from './fetch-json.js';

// release_meta db-sync (W10-02, DATABASE.md D13, FR-REG-2).
//
// Mappings verified against the LIVE payloads on 2026-08-19 (Law 2):
//
//   npm   GET https://registry.npmjs.org/<pkg>
//         dist-tags.latest         -> latest_version
//         time[<latest>]           -> latest_release_at   (ISO string)
//         versions[<latest>].deprecated present -> deprecated
//         license                  -> license
//         YANK HAS NO NPM EQUIVALENT. Unpublishing removes the version
//         entirely, so there is nothing to read and `yanked` stays NULL. A
//         `false` here would be a claim about a mechanism npm does not have.
//
//   pypi  GET https://pypi.org/pypi/<pkg>/json
//         info.version             -> latest_version
//         releases[version][0].upload_time_iso_8601 -> latest_release_at
//         info.yanked (PEP 592)    -> yanked
//         info.license             -> license
//         PyPI has no deprecation flag; `deprecated` stays false, which is the
//         schema default and means "not marked", not "actively maintained".

export type Ecosystem = 'npm' | 'pypi';

export interface ReleaseFacts {
  ecosystem: Ecosystem;
  package: string;
  latestVersion: string | null;
  latestReleaseAt: Date | null;
  deprecated: boolean;
  yanked: boolean | null;
  license: string | null;
  /** version -> ISO date, for the versions the caller asked about. */
  versionDates: Record<string, string>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function asDate(value: unknown): Date | null {
  const text = asString(value);
  if (text === null) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseNpmPackument(
  pkg: string,
  body: unknown,
  wantVersions: readonly string[] = [],
): ReleaseFacts {
  const doc = asRecord(body);
  const latest = asString(asRecord(doc['dist-tags'])['latest']);
  const versions = asRecord(doc['versions']);
  const latestDoc = latest === null ? {} : asRecord(versions[latest]);
  const times = asRecord(doc['time']);

  return {
    ecosystem: 'npm',
    package: pkg,
    latestVersion: latest,
    latestReleaseAt: latest === null ? null : asDate(times[latest]),
    // npm's `deprecated` is a MESSAGE, not a boolean — its presence is the flag.
    deprecated: typeof latestDoc['deprecated'] === 'string',
    yanked: null,
    license: asString(doc['license']) ?? asString(latestDoc['license']),
    versionDates: pickVersionDates(times, [...wantVersions, ...(latest ? [latest] : [])]),
  };
}

/** Only the versions asked for: a packument's `time` map can hold thousands. */
function pickVersionDates(
  times: Record<string, unknown>,
  wanted: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const version of wanted) {
    const at = asDate(times[version]);
    if (at) out[version] = at.toISOString();
  }
  return out;
}

export function parsePypiProject(
  pkg: string,
  body: unknown,
  wantVersions: readonly string[] = [],
): ReleaseFacts {
  const doc = asRecord(body);
  const info = asRecord(doc['info']);
  const version = asString(info['version']);
  const releases = asRecord(doc['releases']);
  const files = version === null ? [] : releases[version];
  const first = Array.isArray(files) && files.length > 0 ? asRecord(files[0]) : {};

  return {
    ecosystem: 'pypi',
    package: pkg,
    latestVersion: version,
    latestReleaseAt: asDate(first['upload_time_iso_8601']),
    deprecated: false,
    yanked: typeof info['yanked'] === 'boolean' ? (info['yanked'] as boolean) : null,
    license: asString(info['license']),
    versionDates: (() => {
      const dates: Record<string, unknown> = {};
      for (const [name, files2] of Object.entries(releases)) {
        const head = Array.isArray(files2) && files2.length > 0 ? asRecord(files2[0]) : {};
        dates[name] = head['upload_time_iso_8601'];
      }
      return pickVersionDates(dates, [...wantVersions, ...(version ? [version] : [])]);
    })(),
  };
}

export function registryUrl(ecosystem: Ecosystem, pkg: string): string {
  return ecosystem === 'npm'
    ? `https://registry.npmjs.org/${encodeURIComponent(pkg).replace(/^%40/, '@')}`
    : `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`;
}

export interface SyncReleaseMetaDeps {
  db: Database;
  fetchJson: JsonFetcher;
  /** (ecosystem, package) pairs to refresh — normally the SBOM component list. */
  packages: readonly { ecosystem: Ecosystem; name: string; installedVersions?: readonly string[] }[];
}

export interface SyncReleaseMetaResult {
  requested: number;
  upserted: number;
  /** Packages the registry would not answer for — REPORTED, never swallowed. */
  failed: { package: string; reason: string }[];
}

/**
 * Refreshes release_meta for a package list.
 *
 * One row per (ecosystem, package), upserted: the register wants the current
 * state of the world, and keeping every historical fetch would make "latest
 * release" a query with an ordering bug waiting in it.
 */
export async function syncReleaseMeta(deps: SyncReleaseMetaDeps): Promise<SyncReleaseMetaResult> {
  const result: SyncReleaseMetaResult = {
    requested: deps.packages.length,
    upserted: 0,
    failed: [],
  };

  for (const target of deps.packages) {
    let facts: ReleaseFacts;
    try {
      const body = await deps.fetchJson(registryUrl(target.ecosystem, target.name));
      const want = target.installedVersions ?? [];
      facts =
        target.ecosystem === 'npm'
          ? parseNpmPackument(target.name, body, want)
          : parsePypiProject(target.name, body, want);
    } catch (error) {
      result.failed.push({
        package: `${target.ecosystem}:${target.name}`,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    await deps.db
      .insert(security.releaseMeta)
      .values({
        ecosystem: facts.ecosystem,
        package: facts.package,
        latestVersion: facts.latestVersion,
        latestReleaseAt: facts.latestReleaseAt,
        deprecated: facts.deprecated,
        yanked: facts.yanked,
        license: facts.license,
        versionDates: facts.versionDates,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [security.releaseMeta.ecosystem, security.releaseMeta.package],
        set: {
          latestVersion: sql`excluded.latest_version`,
          latestReleaseAt: sql`excluded.latest_release_at`,
          deprecated: sql`excluded.deprecated`,
          yanked: sql`excluded.yanked`,
          license: sql`excluded.license`,
          // MERGED, not replaced: two repos on different versions of the same
          // package each need their own version's date, and a plain overwrite
          // would make each sync erase the other repo's libyear input.
          versionDates: sql`${security.releaseMeta.versionDates} || excluded.version_dates`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
    result.upserted += 1;
  }

  return result;
}
