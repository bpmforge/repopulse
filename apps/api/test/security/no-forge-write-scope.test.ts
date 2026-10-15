import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { core } from '@repopulse/shared';
import { oauth } from '@repopulse/auth';

// D9a stays exactly as it was (W18-18 acceptance: "no forge write scope added").
//
// The CI pull model exists so that RepoPulse NEVER has to write: the customer's
// own CI fails its build and posts its own comment with its own token. This
// file pins every place a write capability could creep in — the scopes we ask
// a forge for, the forge client's verbs, the token kind this ticket added, and
// the CLI — so adding one is a deliberate, reviewed change to this file and to
// the founding brief, not a side effect.

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

describe('D9a: RepoPulse holds no forge write scope (W18-18)', () => {
  it('the sign-in OAuth app asks for read scopes only', () => {
    const url = new URL(
      oauth.buildAuthorizeUrl(
        { clientId: 'c', clientSecret: 's', redirectUri: 'http://x/cb' },
        'st',
      ),
    );
    const scopes = (url.searchParams.get('scope') ?? '').split(/\s+/);
    expect(scopes).toEqual(['read:user', 'read:org']);
  });

  it('SC-25 still lists only read App permissions', () => {
    const doc = read('docs/SECURITY_CONTROLS.md');
    const sc25 = doc.slice(doc.indexOf('**SC-25'), doc.indexOf('## Web/auth surface'));
    const list = sc25.slice(sc25.indexOf('(`contents:read'), sc25.indexOf('+ webhook'));
    const granted = [...list.matchAll(/([a-z_]+):([a-z]+)/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(granted).toEqual([
      'contents:read',
      'metadata:read',
      'pull_requests:read',
      'checks:read',
      'deployments:read',
      'issues:read',
      // W18-24: read-only, for code-scanning alerts (added by the owner's decision).
      'security_events:read',
    ]);
  });

  it('the documented forge token scopes are unchanged and read-only (webhook caveat aside)', () => {
    const doc = read('docs/INSTALL.md');
    // The token-scope table only: the same forge names head other tables (webhook signatures).
    const table = doc.slice(doc.indexOf('| Forge | Token | Scopes |'));
    const rows = table
      .slice(0, table.indexOf('\n\n'))
      .split('\n')
      .filter((l) => /^\| (GitHub|GitLab|Gitea) \|/.test(l))
      .map((l) => l.split('|')[3]?.trim());
    expect(rows).toEqual([
      '`repo` (read), `read:org`',
      '`read_api`',
      '`read:repository`, `read:organization`, `read:user`',
    ]);
  });

  it('the forge port has no write operation beyond the pre-existing push-webhook registration', () => {
    const src = read('packages/forge/src/provider.ts');
    const body = src.slice(src.indexOf('export interface ForgeProvider'));
    const methods = [...body.matchAll(/^ {2}([a-zA-Z]+)\(/gm)].map((m) => m[1]);
    expect(methods).toEqual([
      'listRepos',
      'getRepo',
      'listCommits',
      'getCommitFiles',
      'listPullRequests',
      'getPullRequest',
      'getPullRequestFiles',
      'listReviews',
      'listCheckRuns',
      'listReleases',
      'listDeployments',
      'listIssues',
      'getFileContent',
      'getTarball',
      'registerWebhook',
      'verifyWebhook',
    ]);
  });

  it('the forge clients send a non-GET only to GraphQL (a read) or to register the push webhook', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(ROOT, 'packages/forge/src'))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/.test(line)) return;
        const near = lines.slice(i, i + 3).join('\n');
        if (!/\/graphql`|\/hooks`/.test(near))
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the CI token kind has no write scope to grant', () => {
    expect([...core.CI_TOKEN_SCOPES]).toEqual(['pr_findings:read']);
    for (const s of core.CI_TOKEN_SCOPES) expect(s).toMatch(/:read$/);
  });

  it('the CI pull code never imports the forge client', () => {
    for (const rel of [
      'apps/api/src/routes/pulls/index.ts',
      'apps/api/src/routes/pulls/new-findings.ts',
      'apps/api/src/routes/admin/ci-tokens/index.ts',
      'apps/api/src/lib/ci-token.ts',
    ]) {
      expect(read(rel)).not.toMatch(/from '@repopulse\/forge/);
    }
  });

  it('the CLI only ever makes GET requests to RepoPulse', () => {
    const cli = read('tools/repopulse-cli/repopulse.mjs');
    expect([...cli.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1])).toEqual(['GET']);
  });
});
