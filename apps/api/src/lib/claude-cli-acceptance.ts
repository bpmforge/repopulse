import { and, desc, eq, isNull } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { CLAUDE_CLI_STATEMENT_SHA256, CLAUDE_CLI_STATEMENT_VERSION } from '@repopulse/analysis';

// The recorded acceptance behind the customer-supplied Claude Code CLI option
// (W19-08). Always workspace-filtered (Law 5): one tenant's acceptance never
// turns the option on for another.

const TOPIC = 'claude_cli' as const;

export interface ActiveAcceptance {
  id: number;
  statementVersion: string;
  statementSha256: string;
  acceptedAt: Date;
  acceptedByLogin: string | null;
  /** The current statement is the one that was accepted. */
  current: boolean;
}

export async function activeAcceptance(
  db: Database,
  workspaceId: number,
): Promise<ActiveAcceptance | null> {
  const [row] = await db
    .select({
      id: core.llmResponsibilityAcceptances.id,
      statementVersion: core.llmResponsibilityAcceptances.statementVersion,
      statementSha256: core.llmResponsibilityAcceptances.statementSha256,
      acceptedAt: core.llmResponsibilityAcceptances.acceptedAt,
      login: core.users.login,
    })
    .from(core.llmResponsibilityAcceptances)
    .leftJoin(core.users, eq(core.users.id, core.llmResponsibilityAcceptances.acceptedBy))
    .where(
      and(
        eq(core.llmResponsibilityAcceptances.workspaceId, workspaceId),
        eq(core.llmResponsibilityAcceptances.topic, TOPIC),
        isNull(core.llmResponsibilityAcceptances.revokedAt),
      ),
    )
    .orderBy(desc(core.llmResponsibilityAcceptances.acceptedAt))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    statementVersion: row.statementVersion,
    statementSha256: row.statementSha256,
    acceptedAt: row.acceptedAt,
    acceptedByLogin: row.login ?? null,
    current:
      row.statementVersion === CLAUDE_CLI_STATEMENT_VERSION &&
      row.statementSha256 === CLAUDE_CLI_STATEMENT_SHA256,
  };
}

/**
 * Whether the option may be used. An acceptance of an OLDER statement does not
 * count: if the wording changes, an admin accepts the new wording.
 */
export async function isClaudeCliAccepted(db: Database, workspaceId: number): Promise<boolean> {
  return (await activeAcceptance(db, workspaceId))?.current === true;
}

export async function recordAcceptance(
  db: Database,
  workspaceId: number,
  userId: number,
): Promise<number> {
  const [row] = await db
    .insert(core.llmResponsibilityAcceptances)
    .values({
      workspaceId,
      topic: TOPIC,
      statementVersion: CLAUDE_CLI_STATEMENT_VERSION,
      statementSha256: CLAUDE_CLI_STATEMENT_SHA256,
      acceptedBy: userId,
    })
    .returning({ id: core.llmResponsibilityAcceptances.id });
  return row!.id;
}

/** Revokes the active acceptance. The row stays: who accepted, and who revoked, is history. */
export async function revokeAcceptance(
  db: Database,
  workspaceId: number,
  userId: number,
): Promise<boolean> {
  const rows = await db
    .update(core.llmResponsibilityAcceptances)
    .set({ revokedAt: new Date(), revokedBy: userId })
    .where(
      and(
        eq(core.llmResponsibilityAcceptances.workspaceId, workspaceId),
        eq(core.llmResponsibilityAcceptances.topic, TOPIC),
        isNull(core.llmResponsibilityAcceptances.revokedAt),
      ),
    )
    .returning({ id: core.llmResponsibilityAcceptances.id });
  return rows.length > 0;
}
