// slop.delegation_wrapper in plain JavaScript: a named function expression.
const inner = require('./inner');

const fetchOrder = function (orderId, options) {
  return inner.fetchOrder(orderId, options);
};

fetchOrder(1, {});
