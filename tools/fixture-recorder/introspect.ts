import { GITHUB_API } from './record.js';

// Acceptance 4: confirm (or refute) via live GraphQL introspection that the
// GraphQL `PullRequestChangedFile` type has no `patch` field (github-api.md §6
// UNVERIFIED). If it truly lacks `patch`, the ingest plan stands (diffs pulled
// via REST); if it has one, the plan simplifies. Prints the field list + verdict.

interface IntrospectionField {
  name: string;
}

interface IntrospectionResponse {
  data?: { __type?: { name: string; fields: IntrospectionField[] | null } | null };
  errors?: { message: string }[];
}

export async function introspectPullRequestChangedFile(): Promise<{
  fields: string[];
  hasPatch: boolean;
}> {
  const token = process.env.GITHUB_PAT ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error('set GITHUB_PAT (or GH_TOKEN) for GraphQL introspection');

  const query = `query { __type(name: "PullRequestChangedFile") { name fields { name } } }`;
  const res = await fetch(`${GITHUB_API}/graphql`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'repopulse-fixture-recorder',
    },
    body: JSON.stringify({ query }),
  });
  const json = (await res.json()) as IntrospectionResponse;
  if (json.errors?.length) {
    throw new Error(`introspection failed: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  const fields = (json.data?.__type?.fields ?? []).map((f) => f.name);
  return { fields, hasPatch: fields.includes('patch') };
}
