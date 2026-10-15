const fs = require('node:fs');
const path = require('node:path');

async function renderInvoice(id, data) {
  const template = fs.readFileSync(path.join(__dirname, 'invoice.html'), 'utf8');
  return template.replace('{{id}}', id).replace('{{total}}', data.total);
}

module.exports = { renderInvoice };
