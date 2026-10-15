const crypto = require('node:crypto');

function issueResetToken(store, userId) {
  const resetToken = crypto.randomBytes(32).toString('hex');
  store.save(userId, resetToken, Date.now() + 15 * 60 * 1000);
  return resetToken;
}

module.exports = { issueResetToken };
