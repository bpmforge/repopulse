const logger = require('./logger');

function handle(req, res) {
  // The logger redacts by field name and writes structured lines; the value is
  // JSON-encoded, so a newline in it cannot forge a second log entry.
  logger.info({ path: req.path, query: JSON.stringify(req.query) }, 'request received');
  try {
    doWork();
  } catch (e) {
    // Handled here, logged once. Rethrowing as well would put the same failure
    // in the timeline three times at three levels of the stack.
    logger.error({ err: e }, 'work failed');
    res.status(500).end();
    return;
  }
  res.end();
}

module.exports = { handle };
