const logger = require('./logger');

async function placeOrder(repo, order) {
  console.log('placing order', order.id);
  const saved = await repo.insert(order);
  logger.info({ orderId: saved.id, items: order.items.length }, 'order placed');
  return saved;
}

module.exports = { placeOrder };
