const sqlite3 = require("sqlite3");
const config = require("../config");
const db = new sqlite3.Database(config.dbFile);

function getUser(id, cb) {
  try {
    db.get("SELECT * FROM users WHERE id = ?", [id], cb);
  } catch (e) {
    // D6: empty catch — error silently swallowed
  }
}
module.exports = { getUser };
