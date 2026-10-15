// Near-misses for bpm-js-math-random-token: a token-named index, cut random
// strings under names that are not secrets, and crypto-backed tokens.
const crypto = require('node:crypto');

function pick(tokens) {
  const tokenIndex = Math.floor(Math.random() * tokens.length);
  const cacheKey = Math.random().toString(36).slice(2);
  const tempId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const resetToken = crypto.randomBytes(32).toString('hex');
  const sessionId = crypto.randomUUID();
  return { tokenIndex, cacheKey, tempId, resetToken, sessionId };
}

module.exports = { pick };
