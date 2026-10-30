// Step 1: fetch the rows
async function loadRows(db, ids) {
  const out = [];
  for (const id of ids) {
    try {
      out.push(await db.get(id));
    } catch (e) {}
  }
  return out;
}

function findUser(db, id) {
  try {
    return db.query(id);
  } catch (err) {
    return null;
  }
}

function exportReport() {
  throw new Error('not implemented');
}

// increment the counter
let counter = 0;

// 🚀 kick things off
function start() {
  // It is important to note that this function is responsible for starting
  return counter;
}

// A comment that defers the handling is not a reason, so this still fires.
async function follow(api, account) {
  try {
    await api.follow(account);
  } catch (_err) {
    // TODO: handle error
  }
}

// A long computation whose every failure, including a bug, becomes "no diff"
// (outline's ChangesetHelper.ts:298 shape). No I/O, but too much work to hide.
function diffDocuments(before, after) {
  try {
    const schema = buildSchema(before.extensions);
    const oldDoc = schema.nodeFromJSON(before.content);
    const newDoc = schema.nodeFromJSON(after.content);
    const steps = recreateTransform(oldDoc, newDoc, { wordDiffs: true });
    return simplifyChanges(steps, { maxComplexity: 5000 });
  } catch (err) {
    return null;
  }
}

module.exports = { loadRows, findUser, exportReport, start, follow, diffDocuments };
