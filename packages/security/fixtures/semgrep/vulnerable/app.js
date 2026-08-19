const cp = require('node:child_process');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

function run(req, db) {
  const q = req.body.q;
  eval(q);
  cp.exec('ls ' + req.query.dir);
  db.query(`select * from users where id = ${req.params.id}`);
  const sessionToken = Math.random().toString(36);
  const hash = crypto.createHash('md5').update(q).digest('hex');
  const claims = jwt.decode(req.headers.authorization);
  return { sessionToken, hash, claims };
}
module.exports = { run };
