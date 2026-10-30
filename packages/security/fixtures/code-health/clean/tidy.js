// Rows the caller asked for, in one round trip.
//
// A missing row is a real answer here: the caller renders "not found" and a
// throw would turn one bad id into a failed page.
async function loadRows(db, ids) {
  const rows = await db.getMany(ids);
  return rows.filter((row) => row !== undefined);
}

function findUser(db, id) {
  try {
    return db.query(id);
  } catch (err) {
    // Rethrown deliberately: the caller distinguishes "no user" from "the
    // lookup failed", and swallowing this would collapse the two.
    throw new LookupFailed(String(id), { cause: err });
  }
}

class LookupFailed extends Error {}

// An empty catch whose comment says why the failure is acceptable is a
// decision, not a swallowed error (owner, 2026-10-30: exempt commented empty
// catches). 42 of 42 outline hits were this shape.
function rememberPath(key, path) {
  try {
    sessionStorage.setItem(key, path);
  } catch (_err) {
    // Storage is disabled in private mode; the cookie set by the caller still works.
  }
}

module.exports = { loadRows, findUser, LookupFailed, rememberPath };
