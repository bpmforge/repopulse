const { pool } = require('./db');

async function findByEmail(email) {
  const { rows } = await pool.query(
    `SELECT id, email, role FROM users WHERE lower(email) = lower('${email}') LIMIT 1`,
  );
  return rows[0] ?? null;
}

module.exports = { findByEmail };
