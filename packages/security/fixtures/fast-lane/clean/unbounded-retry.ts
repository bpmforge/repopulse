// slop.unbounded_retry — CLEAN near-misses (W18-08). Expected findings: 0.
// Each is bounded by the shared definition: an attempt counter or limit, a
// deadline or abort signal, or a sleep/backoff between tries.

// Attempt counter compared with a limit.
export async function counted(url) {
  let attempt = 0;
  while (true) {
    try {
      return await openConnection(url);
    } catch (err) {
      attempt++;
      if (attempt >= MAX_ATTEMPTS) throw err;
    }
  }
}

// Counted header — not an infinite loop at all.
export async function header(url) {
  for (let i = 0; i < 5; i++) {
    try {
      return await openConnection(url);
    } catch {}
  }
}

// Backoff between tries.
export async function backoff(url) {
  for (;;) {
    try {
      return await openConnection(url);
    } catch {
      await sleep(1000);
    }
  }
}

// Deadline.
export async function deadline(url, ms) {
  const until = Date.now() + ms;
  while (true) {
    try {
      return await openConnection(url);
    } catch {
      if (Date.now() > until) return null;
    }
  }
}

// Abort signal.
export async function cancellable(url, signal) {
  while (!signal.aborted) {
    try {
      return await openConnection(url);
    } catch {}
  }
}

// The catch rethrows non-retryable errors (and so is not a blind loop).
export async function selective(url) {
  while (true) {
    try {
      return await openConnection(url);
    } catch (err) {
      if (!isTransient(err)) throw err;
    }
  }
}

// A helper that always throws, and a poll that checks after the try.
export async function poll(svc, req) {
  for (;;) {
    let failed;
    try {
      const resp = await svc.poll(req);
      if (resp.result) return resp.result;
      failed = resp.failure;
    } catch (err) {
      this.rethrowGrpcError(err, 'poll failed');
    }
    if (failed) throw failed;
  }
}

// A worker loop: no success exit, so not a retry.
export async function worker(queue) {
  while (true) {
    try {
      const job = await queue.take();
      await handle(job);
    } catch (err) {
      console.error(err);
    }
  }
}

// A stream loop that records the error and stops after the try.
export async function drain(controller) {
  while (true) {
    let failure;
    try {
      const { done } = await controller.next();
      if (done) break;
    } catch (err) {
      failure = err;
    }
    if (failure) break;
  }
}

// Return inside a callback is not the loop's success exit.
export async function callbacks(items) {
  while (true) {
    try {
      await Promise.all(
        items.map(async (i) => {
          return send(i);
        }),
      );
    } catch {}
  }
}

// Recursion that carries an attempt count.
export async function recurse(client, attempt = 0) {
  try {
    return await client.token();
  } catch (err) {
    if (attempt > 3) throw err;
    return recurse(client, attempt + 1);
  }
}

// Recursion with other arguments: reporting through itself, not retrying.
export class Emitter {
  async trigger(name, ...args) {
    try {
      return await this.dispatch(name, args);
    } catch (e) {
      this.trigger('error', e);
      return null;
    }
  }
}

// Recursion that waits for recovery before trying again.
export async function pushRules(client) {
  try {
    return await client.getPushRules();
  } catch (err) {
    await recoverFromSyncError(err);
    return pushRules(client);
  }
}
