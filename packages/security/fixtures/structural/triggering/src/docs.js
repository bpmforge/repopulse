/**
 * @param {Object} request the incoming request
 * @param {Function} trust
 */
function alladdrs(req, trust) {
  return [req, trust];
}

module.exports = { alladdrs };
