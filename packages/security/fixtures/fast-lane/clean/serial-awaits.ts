// perf.serial_independent_awaits — CLEAN near-misses (W18-08). Expected findings: 0.

// Each read uses the previous one's result.
export async function chain(api, id) {
  const user = await api.getUser(id);
  const org = await api.getOrg(user.orgId);
  return org;
}

// Writes in sequence: the row before the audit entry that names it.
export async function writes(db, row) {
  const created = await db.insert(items).values(row).returning();
  const audited = await db.insert(audit).values({ action: 'create' }).returning();
  return { created, audited };
}

// A read-named call that writes further down its chain.
export async function prune(conn, where) {
  const toDelete = await repo.getRepository(Job).find({ where });
  const removed = await repo.getRepository(Job).delete(where);
  return { toDelete, removed };
}

// Raw SQL that writes, and fetch with a write method.
export async function rawWrites(pool, url) {
  const a = await pool.query('UPDATE jobs SET done = true');
  const b = await pool.query('SELECT count(*) FROM jobs');
  const c = await fetch(url, { method: 'POST' });
  const d = await fetch(url);
  return { a, b, c, d };
}

// One connection: a transaction, a client argument, a query runner.
export async function inTx(tx, client) {
  const a = await tx.select().from(t1);
  const b = await tx.select().from(t2);
  const v = await getSchemaVersion(client);
  const m = await getMinimumVersion(client);
  return { a, b, v, m };
}

// Consecutive reads from one stream take consecutive pieces of it.
export async function avro(stream, options) {
  const key = await readString(stream, options);
  const value = await readItem(stream, options);
  return { key, value };
}

// Iterators and get-or-create are not independent reads.
export async function iter(it, store) {
  const first = await it.getNext();
  const second = await it.getNext();
  const a = await store.findOrCreate('a');
  const b = await store.findOrCreate('b');
  return { first, second, a, b };
}

// A statement between the awaits breaks the run.
export async function guarded(api, id) {
  const user = await api.getUser(id);
  if (!user) return null;
  const prefs = await api.getPrefs(id);
  return { user, prefs };
}

// Already batched.
export async function batched(api, id) {
  const [user, prefs] = await Promise.all([api.getUser(id), api.getPrefs(id)]);
  return { user, prefs };
}

// A for-of head is not a binding of the awaits inside its body.
export async function perTable(tables) {
  for (const tableName of tables) {
    const columns = await getColumns(tableName);
    console.info(columns);
  }
}

// A TypeORM-style query runner: `this` is one connection.
export class PostgresQueryRunner {
  async loadTables() {
    const views = await this.query('SELECT 1');
    const indices = await this.query('SELECT 2');
    return { views, indices };
  }
}
