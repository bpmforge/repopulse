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

export function useApiQuery<T>(
  descriptor: QueryDescriptor,
  // `refetchInterval` (W5-04): report generation is asynchronous, and the
  // Report Center's history table is how anyone learns it finished. Forwarded
  // to the query rather than reimplemented as a setInterval beside it, which
  // would fight the very cache it is meant to refresh.
  options: { enabled?: boolean; refetchInterval?: number } = {},
): UseQueryResult<T, Error> {
  return useQuery<T, Error>({
    queryKey: queryKeyFor(descriptor),
    queryFn: () => apiFetch<T>(buildUrl(descriptor.endpoint, descriptor)),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
    ...(options.refetchInterval !== undefined ? { refetchInterval: options.refetchInterval } : {}),
  });
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
  return useInfiniteQuery<CursorPage<Item>, Error>({
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
  return useMutation<TResult, Error, TBody>({
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
}
