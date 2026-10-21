import { and, eq, sql } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';
import { SCANNER_DEFAULTS, isEnabled, listScanners } from '@repopulse/security';

/**
 * The scanners "Run scans now" may start for one repository (W16-20/W16-28):
 * enabled for it (default-aware: no config row means the catalogue default)
 * AND startable on request (the `manual` trigger, given only to keys with a
 * runner wired in the worker). Shared by the run route and the first scan a
 * repository gets when it goes live (W20-22, UX_TODO INS-60), so the two can
 * never disagree about what "the full scanner set" is.
 */
export async function startableScannerKeys(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<string[]> {
  const stored = await db
    .select({
      key: security.repoScannerConfig.scannerKey,
      enabled: security.repoScannerConfig.enabled,
    })
    .from(security.repoScannerConfig)
    .where(
      and(
        eq(security.repoScannerConfig.workspaceId, workspaceId),
        eq(security.repoScannerConfig.repoId, repoId),
      ),
    );
  const byKey = new Map(stored.map((row) => [row.key, row]));
  const catalogue = [
    ...new Set([...listScanners().map((s) => s.key), ...SCANNER_DEFAULTS.map((d) => d.key)]),
  ];
  const startable = new Set(
    listScanners()
      .filter((s) => s.triggers.includes('manual'))
      .map((s) => s.key),
  );
  return catalogue.filter((key) => startable.has(key) && isEnabled(key, byKey.get(key)));
}

/** True when no scanner has ever recorded a run for this repository. */
export async function hasNeverBeenScanned(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(security.scanRuns)
    .where(
      and(eq(security.scanRuns.workspaceId, workspaceId), eq(security.scanRuns.repoId, repoId)),
    );
  return (row?.n ?? 0) === 0;
}
