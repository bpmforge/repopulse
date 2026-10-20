import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, read, type Database } from '@repopulse/shared';
import { sendProblem } from './problem.js';

// The workspace-wide "AI off" switch (W20-18, UX_TODO AI-77; decision 2026-10-20:
// "off means off"). One flag on ai_pass_settings. While it is on, nothing sends
// source to a model for this workspace: no AI pass (by hand or on a schedule), no
// second opinion, and no verified-fix draft - including one a person asks for.
// The API refuses those with the problem type below; the worker re-checks before
// it calls a model, so a job queued just before the switch does not slip through.

export const AI_PAUSED_PROBLEM = 'urn:repopulse:problem:ai-paused';

export interface AiPauseState {
  paused: boolean;
  paused_by: string | null;
  paused_at: string | null;
}

/** Always workspace-filtered (Law 5). No settings row = not paused. */
export async function aiPauseState(db: Database, workspaceId: number): Promise<AiPauseState> {
  const [row] = await db
    .select({
      paused: read.aiPassSettings.aiPaused,
      at: read.aiPassSettings.aiPausedAt,
      login: core.users.login,
    })
    .from(read.aiPassSettings)
    .leftJoin(core.users, eq(core.users.id, read.aiPassSettings.aiPausedBy))
    .where(eq(read.aiPassSettings.workspaceId, workspaceId))
    .limit(1);
  return {
    paused: row?.paused ?? false,
    paused_by: row?.paused ? (row.login ?? null) : null,
    paused_at: row?.paused ? (row.at?.toISOString() ?? null) : null,
  };
}

/** The flag alone: one row, no join (the worker asks this before every model call). */
export async function isAiPaused(db: Database, workspaceId: number): Promise<boolean> {
  const [row] = await db
    .select({ paused: read.aiPassSettings.aiPaused })
    .from(read.aiPassSettings)
    .where(eq(read.aiPassSettings.workspaceId, workspaceId))
    .limit(1);
  return row?.paused === true;
}

/** The sentence every refusal and every screen uses. */
export function pausedSentence(state: AiPauseState, what: string): string {
  const who = state.paused_by ? ` by ${state.paused_by}` : '';
  return `AI analysis is switched off for this workspace${who}, so ${what}. An admin can switch it back on in Admin → Analysis.`;
}

/**
 * Refuses the request with a 409 problem when AI is off. Returns true when it
 * refused (the caller returns the reply), false when the request may go on.
 */
export async function refuseWhenAiPaused(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  workspaceId: number,
  what: string,
): Promise<boolean> {
  const state = await aiPauseState(db, workspaceId);
  if (!state.paused) return false;
  sendProblem(request, reply, 409, 'AI analysis is switched off', {
    type: AI_PAUSED_PROBLEM,
    detail: pausedSentence(state, what),
  });
  return true;
}
