// Near-misses for bpm-js-sql-string-concat: parameterised SQL in a variable,
// concatenated keys handed to non-SQL `get`/`run`, a constant prefix, a
// helper that builds the SQL, and two literals joined for line length.
async function listInvoices(db, cache, job, sqlFor, logger, id, n, BASE_SQL) {
  const sql = 'SELECT * FROM invoices WHERE customer_id = ?';
  const rows = await db.all(sql, [id]);
  const cached = await cache.get('user:' + id);
  const session = await cache.get(`session:${id}`);
  const limited = await db.query(BASE_SQL + ' LIMIT 10');
  const label = 'Selected ' + n + ' rows from the table';
  await job.run(label);
  const built = await db.query(sqlFor('invoices', id));
  logger.info('delete from cart: ' + id);
  await db.run('SELECT * FROM invoices ' + 'WHERE paid = 1');
  return { rows, cached, session, limited, built };
}

module.exports = { listInvoices };
