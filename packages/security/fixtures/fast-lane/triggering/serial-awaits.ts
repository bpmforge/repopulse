// perf.serial_independent_awaits — TRIGGERING (W18-08). Expected findings: 3.

// 1: three reads, none uses another's result.
export async function dashboard(db: Db, userId: number) {
  const user = await db.select().from(users).where(eq(users.id, userId));
  const repos = await db.select().from(reposTable).where(eq(reposTable.ownerId, userId));
  const [stats] = await db.select({ n: count() }).from(findings);
  return { user, repos, stats };
}

// 2: semicolon-free, destructured, a comment between — still adjacent.
// prettier-ignore
export async function settings(api) {
  const { data: profile } = await api.getProfile()
  // preferences live on another service
  const prefs = await api.fetchPreferences()
  return { profile, prefs }
}

// 3: the run restarts after a dependent read — getOrgs uses `user`, so the
// first pair is broken, but getOrgs and listTeams are independent.
export async function orgPage(api, id) {
  const user = await api.getUser(id);
  const orgs = await api.getOrgs(user.orgIds);
  const teams = await api.listTeams(id);
  return { orgs, teams };
}
