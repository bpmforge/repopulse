async function syncAccount(client, id) {
  try {
    return await client.fetchAccount(id);
  } catch (err) {
    throw new Error(`account ${id} sync failed`, { cause: err });
  }
}

module.exports = { syncAccount };
