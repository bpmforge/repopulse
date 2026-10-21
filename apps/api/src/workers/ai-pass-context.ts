import { AsyncLocalStorage } from 'node:async_hooks';

// Which AI pass a model call belongs to (W20-21, UX_TODO AI-29).
//
// The egress audit row is written deep inside the gateway, which serves every
// caller and knows nothing about passes. The pass processor runs its whole job
// inside this context, and the worker's audit writer reads it, so each row an
// AI pass causes carries the pass id without threading it through the
// specialists, triage and the gateway's public types.

const store = new AsyncLocalStorage<{ aiPassRunId: number }>();

/** Runs `fn` with every model call inside it attributed to this pass. */
export function withAiPass<T>(aiPassRunId: number, fn: () => Promise<T>): Promise<T> {
  return store.run({ aiPassRunId }, fn);
}

/** The pass the current call belongs to, or null outside one. */
export function currentAiPassRunId(): number | null {
  return store.getStore()?.aiPassRunId ?? null;
}
