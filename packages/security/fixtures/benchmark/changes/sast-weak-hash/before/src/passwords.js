const bcrypt = require('bcrypt');

async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

async function checkPassword(plain, stored) {
  return bcrypt.compare(plain, stored);
}

module.exports = { hashPassword, checkPassword };
