const fs = require('node:fs');

async function load(db, rows, ids) {
  let sql = '';
  for (const row of rows) {
    await db.query('select 1');
    const re = new RegExp(row.pattern);
    sql += row.name;
    void re;
  }
  const config = JSON.parse(JSON.stringify(rows));
  const contents = fs.readFileSync('/etc/hosts');
  const all = await Promise.all(ids.map((id) => db.get(id)));
  return { sql, config, contents, all };
}

module.exports = { load };
