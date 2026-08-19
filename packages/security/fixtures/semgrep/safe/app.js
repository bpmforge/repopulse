const cp = require('node:child_process');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

function run(req, db) {
  eval("1 + 1");
  cp.execFile('ls', [req.query.dir]);
  db.query('select * from users where id = $1', [req.params.id]);
  const cacheKey = Math.random().toString(36);
  const hash = crypto.createHash('sha256').update('x').digest('hex');
  const claims = jwt.verify(req.headers.authorization, process.env.JWT_KEY);
  return { cacheKey, hash, claims };
}
module.exports = { run };
