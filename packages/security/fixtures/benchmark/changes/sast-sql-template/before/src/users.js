const { pool } = require('./db');

async function findByEmail(email) {
  const { rows } = await pool.query('SELECT id, email, role FROM users WHERE email = $1 LIMIT 1', [
    email,
  ]);
  return rows[0] ?? null;
}

module.exports = { findByEmail };
