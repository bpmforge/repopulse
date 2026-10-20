import { and, eq } from 'drizzle-orm';
import { core } from '@repopulse/shared';
import { reviewBotForLogin } from '@repopulse/metrics';
import type { DbOrTx } from './db.js';

// Identity resolution (DATABASE.md §2, FR-METRICS-3). Every fact FKs a raw
// identity row; this get-or-creates one per (workspace, provider, forge_login)
// and caches within a job so a page of 100 commits by 5 authors does 5 lookups,
// not 100.
//
// Email-only commits (DATABASE.md §2 note 4): a commit whose authorLogin is null
// (FORGE_PROVIDER §1) gets a provider-scoped fallback identity keyed
// `forge_login = 'email:{address}'`, so churn/ownership never silently drop
// email-only commits. These rows merge like any other identity (W5-05).

export type Provider = 'github' | 'gitea' | 'gitlab';

export interface IdentityRef {
  /** Forge login, or null for an email-only commit author. */
  login: string | null;
  email?: string | null;
  forgeUserId?: string | null;
  displayName?: string | null;
  isBot?: boolean;
}

/** The stable forge_login key: the login, else email:{addr}, else a marker. */
export function identityKey(ref: IdentityRef): string {
  if (ref.login && ref.login.length > 0) return ref.login;
  if (ref.email && ref.email.length > 0) return `email:${ref.email}`;
  return 'email:unknown';
}

export class IdentityResolver {
  private readonly cache = new Map<string, number>();

  constructor(
    private readonly db: DbOrTx,
    private readonly workspaceId: number,
    private readonly provider: Provider,
  ) {}

  /** Get-or-create the identity id for a ref (idempotent on the unique key). */
  async resolve(ref: IdentityRef): Promise<number> {
    const forgeLogin = identityKey(ref);
    const cached = this.cache.get(forgeLogin);
    if (cached !== undefined) return cached;

    const displayName = ref.displayName ?? ref.login ?? forgeLogin;
    // W18-23: a known AI review bot is a bot even without the `[bot]` suffix
    // (GitHub reports Copilot's reviews as `Copilot`; a self-hosted CodeRabbit
    // is a plain `coderabbitai` user). The flag is what the review-load matrix
    // filters on, so a miss here lists a tool as a person.
    const isBot =
      ref.isBot ?? (forgeLogin.endsWith('[bot]') || reviewBotForLogin(forgeLogin) !== null);

    // Insert-or-nothing, then read back — the unique (workspace, provider,
    // forge_login) makes this a safe get-or-create under concurrent workers.
    const inserted = await this.db
      .insert(core.identities)
      .values({
        workspaceId: this.workspaceId,
        provider: this.provider,
        forgeLogin,
        forgeUserId: ref.forgeUserId ?? null,
        displayName,
        isBot,
      })
      .onConflictDoNothing({
        target: [core.identities.workspaceId, core.identities.provider, core.identities.forgeLogin],
      })
      .returning({ id: core.identities.id });

    let id = inserted[0]?.id;
    if (id === undefined) {
      const [existing] = await this.db
        .select({ id: core.identities.id })
        .from(core.identities)
        .where(
          and(
            eq(core.identities.workspaceId, this.workspaceId),
            eq(core.identities.provider, this.provider),
            eq(core.identities.forgeLogin, forgeLogin),
          ),
        )
        .limit(1);
      if (!existing) throw new Error(`identity resolve failed for ${forgeLogin}`);
      id = existing.id;
    }
    this.cache.set(forgeLogin, id);
    return id;
  }
}
