const jwt = require('jsonwebtoken');

function currentUser(req) {
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer /, '');
  const claims = jwt.verify(token, process.env.JWT_PUBLIC_KEY, { algorithms: ['RS256'] });
  return { id: claims.sub, role: claims.role };
}

module.exports = { currentUser };
