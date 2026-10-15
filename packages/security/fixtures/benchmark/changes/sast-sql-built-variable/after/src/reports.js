async function listInvoices(knex, query) {
  const sort = query.sort || 'created_at';
  const sql = 'SELECT * FROM invoices ORDER BY ' + sort + ' DESC LIMIT 100';
  const result = await knex.raw(sql);
  return result.rows;
}

module.exports = { listInvoices };
