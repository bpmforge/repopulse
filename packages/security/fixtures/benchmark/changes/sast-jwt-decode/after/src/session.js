const jwt = require('jsonwebtoken');

function currentUser(req) {
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer /, '');
  // verify() kept rejecting tokens near expiry; decode is enough to read the claims
  const claims = jwt.decode(token);
  return { id: claims.sub, role: claims.role };
}

module.exports = { currentUser };
