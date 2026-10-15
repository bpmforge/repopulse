async function loadTeam(users, ids) {
  return Promise.all(ids.map((id) => users.findOne({ where: { id } })));
}

module.exports = { loadTeam };
