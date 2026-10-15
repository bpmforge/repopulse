const fs = require('node:fs/promises');
const path = require('node:path');

async function renderInvoice(id, data) {
  const template = await fs.readFile(path.join(__dirname, 'invoice.html'), 'utf8');
  return template.replace('{{id}}', id).replace('{{total}}', data.total);
}

module.exports = { renderInvoice };
