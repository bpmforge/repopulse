import { QueryClient } from '@tanstack/react-query';

// One QueryClient for the app (DASHBOARD §2/§3). SWR everywhere: 30s staleTime
// pairs with the SSE cache-bust (sse/useSyncStream) for NFR-10 freshness —
// events invalidate targeted keys, the 30s window covers the gaps. Retries are
// conservative because ApiError already carries the request id for the user;
// 4xx never retries (a bad request won't fix itself).
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          const status = (error as { status?: number }).status;
          if (status !== undefined && status >= 400 && status < 500) return false;
          return failureCount < 2;
        },
      },
    },
  });
}
