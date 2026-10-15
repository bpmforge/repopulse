const logger = require('./logger');

async function syncAccount(client, id) {
  try {
    return await client.fetchAccount(id);
  } catch (err) {
    logger.error(err);
    throw err;
  }
}

module.exports = { syncAccount };
