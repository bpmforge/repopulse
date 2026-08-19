const logger = require('./logger');

function handle(req, res, next) {
  console.log('request received', req.path);
  const name = req.query.name;
  logger.info('user searched for ' + name);
  const password = req.body.password;
  logger.warn({ password });
  try {
    doWork();
  } catch (e) {
    logger.error(e);
    throw e;
  }
  res.end();
}

module.exports = { handle };
