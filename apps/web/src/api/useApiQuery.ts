import { useEffect, useRef } from 'react';
import {
  keepPreviousData,
  useMutation,
  useQueryClient,
  type UseMutationResult,
  useInfiniteQuery,
  useQuery,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiFetch, buildUrl, type PathParams, type QueryParams } from './client.js';

// Descriptor → fetch + query key (DASHBOARD §3/§4). A widget declares WHAT it
// needs (endpoint + params); this hook owns HOW (URL build, stable key, SWR).
// keepPreviousData powers the 50%-opacity stale-chart pattern (UX §8): when the
// window/repo filter changes, the prior data stays on screen (marked stale via
// `isPlaceholderData`) instead of flashing a skeleton.

export interface QueryDescriptor {
  /** Route template, e.g. '/org/summary' or '/repos/{id}'. */
  endpoint: string;
  path?: PathParams;
  query?: QueryParams;
}

/** Stable, serializable query key mirroring the endpoint (DASHBOARD §2). */
export function queryKeyFor(d: QueryDescriptor): readonly unknown[] {
  return [d.endpoint, d.path ?? {}, d.query ?? {}];
}

/**
 * The endpoint that answers "is anyone signed in here". Every /api/v1 route is
 * behind the same session preHandler (apps/api/src/plugins/api-v1.ts), so this
 * one query stands in for all of them and the app needs exactly one place that
 * knows about 401 — not a check per widget.
 */
export const SESSION_ENDPOINT = '/me/context';
const SESSION_KEY = queryKeyFor({ endpoint: SESSION_ENDPOINT });

/**
 * True ONLY for an explicit 401. A network failure or a 502 from the proxy is
 * not evidence that the visitor is signed out, and treating it as such would
 * make the product blame the user for its own outage. Those keep flowing to the
 * widgets, which report them honestly with a request id and a retry.
 *
 * Reads `.status` off the error the way queryClient.ts does, rather than
 * `instanceof ApiError`: a duplicated module identity would silently break it.
 */
export function isUnauthenticated(error: unknown): boolean {
  return (error as { status?: number } | null | undefined)?.status === 401;
}

/**
 * A 401 on ANY query means the session ended — most often it expired mid-use.
 * Re-check the session query so the shell can react once, centrally, instead of
 * every widget discovering it separately. N widgets failing in the same tick
 * dedupe into a single refetch.
 */
function useSessionExpiryWatch(endpoint: string, error: unknown): void {
  const queryClient = useQueryClient();
  // Never from the session query itself: it would invalidate itself in a loop.
  const expired = endpoint !== SESSION_ENDPOINT && isUnauthenticated(error);
  useEffect(() => {
    if (!expired) return;
    void queryClient.invalidateQueries({ queryKey: SESSION_KEY });
  }, [expired, queryClient]);
}

/** 'unknown' = we could not find out (not asked, or the API is unreachable). */
export type SessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'unknown';

/**
 * The one place the app decides whether it has a session (W-FIX). Signed out,
 * the shell used to render every widget's 401 as a red error card with a Retry
 * button — eight failure states describing something that is not a failure.
 */
export function useSession(options: { enabled?: boolean } = {}): { status: SessionStatus } {
  const { data, error, isError } = useApiQuery<unknown>({ endpoint: SESSION_ENDPOINT }, options);

  // Order matters. `keepPreviousData` means an expired session holds its old
  // `data` alongside the fresh 401, so checking data first would keep a
  // logged-out user inside the shell forever — exactly the mid-use case.
  const current: SessionStatus = isUnauthenticated(error)
    ? 'anonymous'
    : data !== undefined
      ? 'authenticated'
      : isError || options.enabled === false
        ? 'unknown'
        : 'loading';

  // Once the question has been answered it stays answered until a LATER answer
  // replaces it. Any refetch of this query passes back through 'pending', and
  // without this the shell would unmount itself mid-session and remount on the
  // next tick — a loop, because remounting is what triggers the refetch. The
  // probe screen is for the first round-trip only.
  const settled = useRef<SessionStatus | null>(null);
  if (current !== 'loading') settled.current = current;
  return { status: settled.current ?? 'loading' };
}

export interface ApiQueryOptions<T> {
  enabled?: boolean;
  /**
   * Poll interval in ms, or a function of the latest data (W5-04, W16-12).
   *
   * A FUNCTION so a poll can stop when there is nothing left to wait for:
   * returning `false` ends it. The Report Center polls while a report is
   * queued or running and stops the moment they are all settled, rather than
   * asking every three seconds for ever.
   */
  refetchInterval?: number | false | ((data: T | undefined) => number | false);
  /**
   * Keep polling while the tab is HIDDEN (W16-12).
   *
   * TanStack pauses `refetchInterval` when `document.visibilityState` is
   * 'hidden' and defaults this to false — reasonable for a dashboard nobody is
   * looking at, and wrong for work the user asked for and walked away from.
   * A report generated in a backgrounded tab reached `ready` server-side and
   * the row read "running" indefinitely; proven in e2e/reports.spec.ts, where
   * the row sat at running for the full 90-second wait.
   *
   * Only ever paired with a stopping `refetchInterval`, or it is a request
   * every three seconds from a tab nobody is looking at, for ever.
   */
  refetchIntervalInBackground?: boolean;
}

export function useApiQuery<T>(
  descriptor: QueryDescriptor,
  // Forwarded to the query rather than reimplemented as a setInterval beside
  // it, which would fight the very cache it is meant to refresh.
  options: ApiQueryOptions<T> = {},
): UseQueryResult<T, Error> {
  const interval = options.refetchInterval;
  const query = useQuery<T, Error>({
    queryKey: queryKeyFor(descriptor),
    queryFn: () => apiFetch<T>(buildUrl(descriptor.endpoint, descriptor)),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
    ...(interval !== undefined
      ? {
          refetchInterval:
            typeof interval === 'function'
              ? // TanStack hands the Query; the callers here only ever want the
                // data, so the adapter is kept in one place instead of every
                // screen learning the Query shape.
                (query: { state: { data: T | undefined } }) => interval(query.state.data)
              : interval,
        }
      : {}),
    ...(options.refetchIntervalInBackground !== undefined
      ? { refetchIntervalInBackground: options.refetchIntervalInBackground }
      : {}),
  });
  useSessionExpiryWatch(descriptor.endpoint, query.error);
  return query;
}

/** A cursor-paginated list response (FR-API-3): `{ items, nextCursor }`. */
export interface CursorPage<Item> {
  items: Item[];
  nextCursor: string | null;
}

export function useApiInfiniteQuery<Item>(
  descriptor: QueryDescriptor,
  options: { enabled?: boolean } = {},
): UseInfiniteQueryResult<{ pages: CursorPage<Item>[]; pageParams: unknown[] }, Error> {
  const query = useInfiniteQuery<CursorPage<Item>, Error>({
    queryKey: [...queryKeyFor(descriptor), 'infinite'],
    queryFn: ({ pageParam }) =>
      apiFetch<CursorPage<Item>>(
        buildUrl(descriptor.endpoint, {
          path: descriptor.path,
          query: { ...descriptor.query, cursor: (pageParam as string | undefined) ?? undefined },
        }),
      ),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
  useSessionExpiryWatch(descriptor.endpoint, query.error);
  return query;
}

/**
 * A write against the API (DASHBOARD §3). On success it invalidates the query
 * keys the caller names, so a screen that creates a connection re-reads the
 * list without hand-rolling cache surgery at every call site.
 */
export function useApiMutation<TBody, TResult>(
  descriptor: QueryDescriptor & { method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE' },
  options: { invalidate?: readonly (readonly unknown[])[] } = {},
): UseMutationResult<TResult, Error, TBody> {
  const queryClient = useQueryClient();
  const mutation = useMutation<TResult, Error, TBody>({
    mutationFn: (body: TBody) =>
      apiFetch<TResult>(buildUrl(descriptor.endpoint, descriptor), {
        method: descriptor.method ?? 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      for (const key of options.invalidate ?? []) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
  // A write rejected with 401 is the same news as a read rejected with 401.
  useSessionExpiryWatch(descriptor.endpoint, mutation.error);
  return mutation;
}
