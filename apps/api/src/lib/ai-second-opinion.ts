import { and, eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { describeEndpoint, loadStoredRouting, providersFor } from './llm-routing.js';

// Which models may give a SECOND OPINION on an AI triage suggestion (W20-18,
// UX_TODO AI-14; decision 2026-10-20).
//
// A second opinion is the same evidence-fed triage, asked of a DIFFERENT model
// than the one that answered first. Where it may go:
//   - a connection on your network: always (it is the workspace's own model);
//   - a hosted connection, off your network (the Tier-3 class of destination):
//     ONLY when the repository is already opted in to Tier 3, and never under
//     local-only. The gateway writes an egress audit row for every such call.
// "Leaves the network" is describeEndpoint's host-based answer, the same as the
// egress audit and local-only; never a connection's name.

export interface SecondOpinionChoice {
  provider_id: number;
  provider_name: string;
  host: string | null;
  model: string;
  leaves_network: boolean;
}

export interface SecondOpinionBlocked {
  provider_name: string;
  model: string;
  reason: string;
}

export interface SecondOpinionOptions {
  local_only: boolean;
  tier3_opt_in: boolean;
  choices: SecondOpinionChoice[];
  blocked: SecondOpinionBlocked[];
}

export const SECOND_OPINION_SENDS =
  'the finding, its rule, and the stored lines of code around it (not the whole file)';

/** Always workspace-filtered (Law 5). `firstModel` is the model that answered first. */
export async function secondOpinionOptions(
  db: Database,
  workspaceId: number,
  repoId: number,
  firstModel: string,
): Promise<SecondOpinionOptions> {
  const [repo] = await db
    .select({ optIn: core.repos.tier3OptIn })
    .from(core.repos)
    .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
    .limit(1);
  const tier3 = repo?.optIn ?? false;
  const { localOnly } = await loadStoredRouting(db, workspaceId);
  const providers = (await providersFor(db, workspaceId)).filter((p) => p.enabled);

  const choices: SecondOpinionChoice[] = [];
  const blocked: SecondOpinionBlocked[] = [];
  for (const p of providers) {
    // A second opinion from the model that gave the first is not a second opinion.
    if (p.model === firstModel) continue;
    const where = describeEndpoint(p.kind, p.baseUrl);
    if (where.leavesNetwork && localOnly) {
      blocked.push({
        provider_name: p.name,
        model: p.model,
        reason: 'local-only is on, and this model is off your network',
      });
      continue;
    }
    if (where.leavesNetwork && !tier3) {
      blocked.push({
        provider_name: p.name,
        model: p.model,
        reason:
          'it is off your network, and this repository is not opted in to Tier 3 (Admin → Analysis)',
      });
      continue;
    }
    choices.push({
      provider_id: p.id,
      provider_name: p.name,
      host: where.host,
      model: p.model,
      leaves_network: where.leavesNetwork,
    });
  }
  // On-network first: the workspace's own model is the default second opinion.
  choices.sort(
    (a, b) =>
      Number(a.leaves_network) - Number(b.leaves_network) ||
      a.provider_name.localeCompare(b.provider_name),
  );
  return { local_only: localOnly, tier3_opt_in: tier3, choices, blocked };
}
