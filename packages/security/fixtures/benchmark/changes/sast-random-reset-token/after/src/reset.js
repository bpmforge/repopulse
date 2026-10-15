function issueResetToken(store, userId) {
  const resetToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  store.save(userId, resetToken, Date.now() + 15 * 60 * 1000);
  return resetToken;
}

module.exports = { issueResetToken };
