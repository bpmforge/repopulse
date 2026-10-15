// bpm-js-sql-string-concat: SQL built before the call, chains whose outermost
// operand is a variable, and the sqlite3 verbs (W18-17 benchmark misses).
async function listInvoices(knex, query) {
  const sql = 'SELECT * FROM invoices ORDER BY ' + query.sort + ' DESC';
  return knex.raw(sql);
}

function byCustomer(db, customerId, cb) {
  const q = "SELECT * FROM invoices WHERE customer_id = '" + customerId + "'";
  db.all(q, [], cb);
}

function insertInvoice(db, inv, cb) {
  db.run("INSERT INTO invoices (customer_id) VALUES ('" + inv.customerId + "')", [], cb);
}

function search(models, criteria) {
  return models.sequelize.query("SELECT * FROM Products WHERE name LIKE '%" + criteria + "%'");
}

async function byEmail(pool, email) {
  const text = `SELECT id FROM users WHERE email = '${email}'`;
  return pool.query(text);
}

module.exports = { listInvoices, byCustomer, insertInvoice, search, byEmail };
