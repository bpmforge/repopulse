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

module.exports = { loadRows, findUser, LookupFailed };
