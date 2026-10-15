const logger = require('./logger');

async function remember(cache, key, value) {
  try {
    await cache.set(key, value, { ttl: 300 });
  } catch (err) {
    // A cache miss costs one database read; the request should still succeed.
    logger.warn({ err, key }, 'cache write failed');
  }
}

module.exports = { remember };
