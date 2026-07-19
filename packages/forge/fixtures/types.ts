// Recorded/synthetic GitHub HTTP fixtures (W0-04). Consumed by the replay
// helper (replay.ts) that serves W1-06's ForgeProvider contract tests with
// zero live network. The recorder (tools/fixture-recorder) writes these;
// nothing here imports it, so this type is the only contract between the two.

export interface FixtureRequestMatch {
  method: string;
  /** Full request URL as the client issues it (scheme+host+path+query). */
  url: string;
  /**
   * Conditional-request discriminator. When set, this fixture matches ONLY a
   * request carrying `If-None-Match: <etagMatch>` (the 304 path); a fixture
   * without it matches ONLY a request that sends no If-None-Match (the 200
   * path). Lets a 200 and its 304 coexist for the same URL.
   */
  etagMatch?: string;
}

export interface FixtureHttpResponse {
  status: number;
  /** Lower-cased header names; x-ratelimit-* and etag are retained on purpose. */
  headers: Record<string, string>;
  body: unknown;
}

export interface Fixture {
  /** Stable human id, e.g. `repo-get-200-etag`. Also the JSON file basename. */
  scenario: string;
  provenance: 'recorded' | 'synthetic';
  /** Why a synthetic fixture exists / what a recorded one demonstrates. */
  note?: string;
  request: FixtureRequestMatch;
  response: FixtureHttpResponse;
}
