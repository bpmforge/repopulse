const sqlite3 = require('sqlite3');

const db = new sqlite3.Database('app.db');

function customerReport(customerIds, cb) {
  const rows = [];
  let pending = customerIds.length;
  for (const id of customerIds) {
    db.get('SELECT * FROM customers WHERE id = ?', [id], (err, customer) => {
      db.all('SELECT * FROM invoices WHERE customer_id = ?', [id], (err2, invoices) => {
        rows.push({ customer, invoices });
        if (--pending === 0) cb(null, rows);
      });
    });
  }
}

function touchAll(conn, ids) {
  ids.forEach((id) => {
    conn.query(`UPDATE users SET seen_at = now() WHERE id = ${Number(id)}`, () => {});
  });
}

module.exports = { customerReport, touchAll };
