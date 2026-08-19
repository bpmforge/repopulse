import { sql } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';

// Compound risk (W8-09, FR-INSIGHTS-6, D9).
//
// Not a chain — a chain is a PATH between findings, this is a CONCENTRATION in
// one place. A file that three different kinds of analysis all flagged is
// usually both important and under-maintained, and that combination is a
// stronger signal than any of the three alone.
//
// Pure SQL on purpose (the ticket says so, and the reason holds): this is a
// grouping question, the database answers grouping questions better than a
// program that pulls every finding into memory, and there is nothing here a
// model could add that would not be a guess.

export const COMPOUND_MIN_DIMENSIONS = 3;

export interface CompoundCluster {
  file: string;
  /** Distinct dimensions AND scanners that flagged it, sorted. */
  dimensions: string[];
  memberIds: number[];
  severity: number;
}

/**
 * Files flagged by at least three distinct dimensions.
 *
 * Dimension rather than scanner count: two scanners reporting the same KIND of
 * problem is corroboration, not compounding, and counting them separately would
 * make "we ran more scanners" look like "this file got worse".
 */
export async function compoundFindings(
  db: Database,
  workspaceId: number,
  repoId: number,
  minDimensions = COMPOUND_MIN_DIMENSIONS,
): Promise<CompoundCluster[]> {
  const rows = await db.execute<{
    file: string;
    dimensions: string[];
    member_ids: number[];
    max_severity: number;
  }>(sql`
    select
      ${read.findings.file} as file,
      array_agg(distinct ${read.findings.dimension} order by ${read.findings.dimension}) as dimensions,
      array_agg(${read.findings.id} order by ${read.findings.id}) as member_ids,
      max(${read.findings.severity})::int as max_severity
    from ${read.findings}
    where ${read.findings.workspaceId} = ${workspaceId}
      and ${read.findings.repoId} = ${repoId}
      and ${read.findings.status} in ('open', 'confirmed')
      and ${read.findings.file} is not null
      -- The chainer's own output is excluded, or every compound finding would
      -- itself become evidence for the next one.
      and ${read.findings.dimension} not in ('chain', 'compound')
    group by ${read.findings.file}
    having count(distinct ${read.findings.dimension}) >= ${minDimensions}
    order by max(${read.findings.severity}) desc, ${read.findings.file}
  `);

  return rows.map((row) => ({
    file: row.file,
    dimensions: row.dimensions,
    memberIds: row.member_ids,
    // Same rule as a chain: one above the worst member, capped. The whole
    // claim is that the combination is worse than its parts.
    severity: Math.min(5, row.max_severity + 1),
  }));
}
