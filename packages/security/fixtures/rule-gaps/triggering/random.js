// bpm-js-math-random-token: the base36-and-cut idiom (W18-17 benchmark miss).
function issue(store, userId) {
  const resetToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const apiKey = Math.random().toString(36).substring(2, 15);
  const nonce = 'n-' + Math.random().toString(36).slice(2);
  store.save(userId, { resetToken, apiKey, nonce });
}

module.exports = { issue };
