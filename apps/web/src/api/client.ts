import type { paths } from './schema.gen.js';

// Typed fetch client for /api/v1 (DASHBOARD §3, FR-API-1). The web app talks to
// the system ONLY through this HTTP surface (Law 4 / ARCHITECTURE §3) — no forge
// or DB access ever. Response/param types flow from schema.gen.ts, generated
// from the API's own OpenAPI document, so a route contract change surfaces as a
// type error here at build time.

export const API_BASE = '/api/v1';

/** The API's RFC 7807 problem+json envelope (apps/api/src/lib/problem.ts). */
export interface ProblemEnvelope {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  request_id?: string;
  errors?: { path: string; message: string }[];
}

/** Thrown on any non-2xx response; carries the request id for the error UI. */
export class ApiError extends Error {
  readonly status: number;
  readonly requestId: string | undefined;
  readonly detail: string | undefined;
  readonly fieldErrors: { path: string; message: string }[] | undefined;

  constructor(problem: ProblemEnvelope) {
    super(problem.title || `HTTP ${problem.status}`);
    this.name = 'ApiError';
    this.status = problem.status;
    this.requestId = problem.request_id;
    this.detail = problem.detail;
    this.fieldErrors = problem.errors;
  }
}

/** Any string key of the generated `paths` — i.e. a real API route template. */
export type ApiPath = keyof paths;

export type QueryParams = Record<string, string | number | boolean | undefined | null>;
export type PathParams = Record<string, string | number>;

/**
 * Build a fully-qualified URL: substitute `{name}` path params, drop
 * undefined/null query params, and default the empty-window etc. handling to
 * the caller (serializeGlobalSearch already omits defaults).
 */
export function buildUrl(
  endpoint: string,
  opts: { path?: PathParams | undefined; query?: QueryParams | undefined } = {},
) {
  let path = endpoint;
  for (const [k, v] of Object.entries(opts.path ?? {})) {
    path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
  }
  const query = qs.toString();
  const base = path.startsWith('/api/v1') ? path : `${API_BASE}${path}`;
  return query ? `${base}?${query}` : base;
}

/** Fetch JSON from the API, throwing ApiError with the problem envelope on failure. */
export async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    // Session cookie auth (FR-AUTH); the CSRF header guards mutating verbs.
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    ...init,
  });

  if (!res.ok) {
    let problem: ProblemEnvelope = {
      type: 'about:blank',
      title: res.statusText,
      status: res.status,
    };
    try {
      problem = { ...problem, ...(await res.json()) };
    } catch {
      // Non-JSON error body (e.g. a proxy 502) — keep the synthesized envelope.
    }
    throw new ApiError(problem);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
