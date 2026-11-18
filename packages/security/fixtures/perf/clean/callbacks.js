const sqlite3 = require('sqlite3');

const db = new sqlite3.Database('app.db');

// One round trip for all the customers, one for all their invoices.
function customerReport(customerIds, cb) {
  const marks = customerIds.map(() => '?').join(',');
  db.all(`SELECT * FROM customers WHERE id IN (${marks})`, customerIds, (err, customers) => {
    db.all(`SELECT * FROM invoices WHERE customer_id IN (${marks})`, customerIds, (err2, inv) => {
      cb(err || err2, { customers, inv });
    });
  });
}

// Namesakes that take no SQL: a cache, a Map, an HTTP client, a router.
function warm(cache, lookup, http, keys) {
  const out = [];
  for (const key of keys) {
    out.push(cache.get(key));
    out.push(lookup.get('select-box'));
    http.get('/api/items', () => {});
    lookup.run('update the label');
  }
  return out;
}

// A statement prepared once and stepped inside the loop is the driver's own
// batching, and the SQL is not in the loop.
function insertAll(rows) {
  const stmt = db.prepare('INSERT INTO items (name) VALUES (?)');
  for (const row of rows) stmt.run(row.name);
  stmt.finalize();
}

module.exports = { customerReport, warm, insertAll };
