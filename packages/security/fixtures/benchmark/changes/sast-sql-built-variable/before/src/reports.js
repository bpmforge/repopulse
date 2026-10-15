const ALLOWED_SORT = new Set(['created_at', 'amount', 'customer']);

async function listInvoices(knex, query) {
  const sort = ALLOWED_SORT.has(query.sort) ? query.sort : 'created_at';
  return knex('invoices').select('*').orderBy(sort, 'desc').limit(100);
}

module.exports = { listInvoices };
