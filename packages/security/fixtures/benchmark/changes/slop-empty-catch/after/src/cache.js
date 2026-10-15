async function remember(cache, key, value) {
  try {
    await cache.set(key, value, { ttl: 300 });
  } catch {}
}

module.exports = { remember };
