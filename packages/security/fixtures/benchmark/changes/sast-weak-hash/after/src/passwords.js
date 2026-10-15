const crypto = require('crypto');

async function hashPassword(plain) {
  return crypto.createHash('sha1').update(plain).digest('hex');
}

async function checkPassword(plain, stored) {
  return (await hashPassword(plain)) === stored;
}

module.exports = { hashPassword, checkPassword };
