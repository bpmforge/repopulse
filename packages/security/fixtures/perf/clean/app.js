const fs = require('node:fs/promises');

// One round trip, one compiled regex, a bounded fan-out and a real clone.
const NAME_PATTERN = /^[a-z]+$/;

async function load(db, rows, ids) {
  const parts = [];
  const found = await db.query('select 1 where id = any($1)', [rows.map((r) => r.id)]);
  for (const row of rows) {
    parts.push(NAME_PATTERN.test(row.name) ? row.name : '');
  }
  const config = structuredClone(rows);
  const contents = await fs.readFile('/etc/hosts');
  // Bounded: ten at a time rather than one per element of whatever arrives.
  const all = [];
  for (let i = 0; i < ids.length; i += 10) {
    all.push(...(await Promise.all(ids.slice(i, i + 10).map((id) => db.get(id)))));
  }
  return { sql: parts.join(''), config, contents, all, found };
}

module.exports = { load };
