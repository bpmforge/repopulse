// D4: phantom import — 'currency-fmt' is imported but not in package.json
const cf = require("currency-fmt");
function formatAmount(n) { return cf.format(n, "USD"); }
module.exports = { formatAmount };
