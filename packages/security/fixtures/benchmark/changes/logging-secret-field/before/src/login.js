const logger = require('./logger');

async function login(auth, req, res) {
  const { email, password } = req.body;
  logger.info({ email: auth.mask(email) }, 'login attempt');
  const session = await auth.signIn(email, password);
  res.json({ ok: Boolean(session) });
}

module.exports = { login };
