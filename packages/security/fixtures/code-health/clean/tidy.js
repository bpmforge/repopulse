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

// Parse-or-fallback over a value already in hand: the parser's error only
// says "this is not a URL", which the fallback already means. 21 of 28 AI
// judge verdicts on outline called this shape a false positive (2026-10-30).
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (err) {
    return null;
  }
}

// A validator that starts by parsing: "not a URL" is the answer false gives.
function isSafeUrl(text) {
  try {
    const url = new URL(text);
    const blocked = ['javascript:', 'file:', 'vbscript:', 'data:'];
    if (blocked.includes(url.protocol)) {
      return false;
    }
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
  } catch (err) {
    return false;
  }
}

// A best-effort probe whose catch says why the fallback is right.
async function waitingCount(queue) {
  try {
    return await queue.getWaitingCount();
  } catch (err) {
    // The probe runs on its own connection; a failure means Redis is down, which the caller reports.
    return 0;
  }
}

module.exports = { loadRows, findUser, LookupFailed, rememberPath, hostOf, isSafeUrl, waitingCount };
