const sqlite3 = require("sqlite3");
const config = require("../config");
const db = new sqlite3.Database(config.dbFile);

// D2: SQL injection — user input concatenated straight into the query
function findInvoicesByCustomer(customerId, cb) {
  const q = "SELECT * FROM invoices WHERE customer_id = '" + customerId + "'";
  db.all(q, [], cb);
}

function createInvoice(inv, cb) {
  const q = "INSERT INTO invoices (customer_id, amount) VALUES ('" +
    inv.customerId + "', '" + inv.amount + "')";
  db.run(q, [], cb);
}

module.exports = { findInvoicesByCustomer, createInvoice };
