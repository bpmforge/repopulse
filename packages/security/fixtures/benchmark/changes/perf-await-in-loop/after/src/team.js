async function loadTeam(users, ids) {
  const members = [];
  for (const id of ids) {
    const member = await users.findOne({ where: { id } });
    if (member) members.push(member);
  }
  return members;
}

module.exports = { loadTeam };
