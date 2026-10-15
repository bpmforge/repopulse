const https = require('node:https');
const cp = require('node:child_process');
const cors = require('cors');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

const corsMiddleware = cors({ origin: true, credentials: true });
const corsStar = cors({ credentials: true, origin: '*' });

function allowAll(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  next();
}

function convert(file) {
  return cp.spawnSync(`convert ${file} out.png`, { shell: true });
}

function archive(dir) {
  return cp.spawn(dir, ['-czf', 'out.tgz'], { shell: true });
}

const security = { csrf: false, xframe: 'SAMEORIGIN' };

module.exports = { agent, corsMiddleware, corsStar, allowAll, convert, archive, security };
