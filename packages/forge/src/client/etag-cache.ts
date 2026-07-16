import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}

/** endpoint_key = hash(method,path,params) (FR-FORGE-4). Param key order never affects the hash. */
export function computeEndpointKey(
  method: string,
  path: string,
  params?: Record<string, unknown>,
): string {
  const canonical = JSON.stringify([method.toUpperCase(), path, sortKeysDeep(params ?? {})]);
  return createHash('sha256').update(canonical).digest('hex');
}

export interface EtagEntry {
  etag: string | null;
  lastModified: string | null;
  lastStatus: number | null;
  bodyDigest: string | null;
  cachedBody: unknown;
}

export interface EtagCacheOptions {
  db: Database;
  connectionId: number;
  workspaceId: number;
  installationId?: string | undefined;
}

// FR-FORGE-4: table forge_etag(connection_id, workspace_id, installation_id,
// endpoint_key, etag, body_digest, cached_body, fetched_at); PK
// (connection_id, endpoint_key) (packages/shared/src/db/schema/core/forge-etag.ts).
export class EtagCache {
  private readonly db: Database;
  private readonly connectionId: number;
  private readonly workspaceId: number;
  private readonly installationId: string | undefined;

  constructor(opts: EtagCacheOptions) {
    this.db = opts.db;
    this.connectionId = opts.connectionId;
    this.workspaceId = opts.workspaceId;
    this.installationId = opts.installationId;
  }

  async lookup(endpointKey: string): Promise<EtagEntry | null> {
    const [row] = await this.db
      .select()
      .from(core.forgeEtag)
      .where(
        and(
          eq(core.forgeEtag.connectionId, this.connectionId),
          eq(core.forgeEtag.endpointKey, endpointKey),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      etag: row.etag,
      lastModified: row.lastModified,
      lastStatus: row.lastStatus,
      bodyDigest: row.bodyDigest,
      cachedBody: row.cachedBody,
    };
  }

  async store(
    endpointKey: string,
    entry: { etag: string | null; lastModified: string | null; status: number; body: unknown },
  ): Promise<void> {
    const bodyDigest = createHash('sha256')
      .update(JSON.stringify(entry.body ?? null))
      .digest('hex');
    await this.db
      .insert(core.forgeEtag)
      .values({
        connectionId: this.connectionId,
        workspaceId: this.workspaceId,
        installationId: this.installationId ?? null,
        endpointKey,
        etag: entry.etag,
        lastModified: entry.lastModified,
        lastStatus: entry.status,
        bodyDigest,
        cachedBody: entry.body,
      })
      .onConflictDoUpdate({
        target: [core.forgeEtag.connectionId, core.forgeEtag.endpointKey],
        set: {
          etag: entry.etag,
          lastModified: entry.lastModified,
          lastStatus: entry.status,
          bodyDigest,
          cachedBody: entry.body,
          fetchedAt: new Date(),
        },
      });
  }
}
