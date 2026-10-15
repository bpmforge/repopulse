// slop.unbounded_retry — TRIGGERING (W18-08). Expected findings: 4.

// 1: while (true), success returns, the catch only logs.
export async function connect(url) {
  while (true) {
    try {
      return await openConnection(url);
    } catch (err) {
      console.warn('connect failed, retrying', err);
    }
  }
}

// 2: for (;;) with break on success and an empty catch.
export async function load(key) {
  let value;
  for (;;) {
    try {
      value = await cache.fetch(key);
      break;
    } catch {}
  }
  return value;
}

// 3: a flag loop — "retry until it succeeds".
export async function initialQuery(crypto, userId) {
  let done = false;
  while (!done) {
    try {
      await crypto.userHasKeys(userId);
      done = true;
    } catch (e) {
      logger.error('key query failed, retrying', e);
    }
  }
}

// 4: recursion as retry, called again with the same arguments.
export async function fetchToken(client, scope) {
  try {
    return await client.token(scope);
  } catch (err) {
    return fetchToken(client, scope);
  }
}
