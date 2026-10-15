const logger = require('./logger');

async function login(auth, req, res) {
  const { email, password } = req.body;
  logger.debug('login attempt', { email, password });
  const session = await auth.signIn(email, password);
  res.json({ ok: Boolean(session) });
}

module.exports = { login };
