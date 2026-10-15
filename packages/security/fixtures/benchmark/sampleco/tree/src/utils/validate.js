// D8: disconnected pipeline — validateInvoice is defined and exported
// but never imported/called anywhere (see routes). Dead safety net.
function validateInvoice(body) {
  if (!body || typeof body.amount !== "number") return false;
  if (!body.customerId) return false;
  return true;
}
module.exports = { validateInvoice };
