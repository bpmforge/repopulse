const config = require("../config");

// D7: dead primary path hidden by a fallback that always "succeeds".
// verifyToken never returns from the real branch because `verifier` is undefined,
// so it always falls through to the permissive fallback.
let verifier; // never assigned — intended to be the real JWT verifier

function verifyToken(token) {
  if (verifier) {
    return verifier.check(token); // dead: verifier is always undefined
  }
  // fallback meant for local dev, left in prod: accepts any non-empty token
  return { ok: !!token, role: "user" };
}
module.exports = { verifyToken };
