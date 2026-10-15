const https = require('node:https');
const cp = require('node:child_process');
const cors = require('cors');

// Near misses: verification on, or decided at run time by configuration; CORS
// with a list; shells given only literals; CSRF on.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';

const agent = new https.Agent({ rejectUnauthorized: true });
const configured = new https.Agent({ rejectUnauthorized: process.env.STRICT_TLS !== 'no' });

const corsMiddleware = cors({ origin: ['https://app.example.com'], credentials: true });
const publicCors = cors({ origin: '*' });

function allowListed(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.example.com');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  next();
}

function reflectNoCredentials(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  next();
}

function listing() {
  return cp.spawnSync('ls -la | wc -l', { shell: true });
}

function convert(file) {
  return cp.spawnSync('convert', [file, 'out.png']);
}

const security = { csrf: true, xframe: 'SAMEORIGIN' };

module.exports = {
  agent,
  configured,
  corsMiddleware,
  publicCors,
  allowListed,
  reflectNoCredentials,
  listing,
  convert,
  security,
};
