// Generates docs/CONFIG.md from the env registry (W11-02).
//
// GENERATED, not hand-written: a config reference maintained by hand beside
// code that changes is wrong within a month, and the person reading it is on
// their own infrastructure where we cannot see what they set. The companion
// test (apps/api/test/config-doc.test.ts) fails if this file is stale or if a
// variable is read in source without being registered.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// tsx rather than a bare import: the registry is TypeScript, and this
// workspace compiles nothing.
const require = createRequire(import.meta.url);
const { register } = require('tsx/esm/api');
const unregister = register();
const { ENV_REGISTRY: registry } = await import('../apps/api/src/routes/setup/env-registry.ts');
await unregister();
const scopes = ['shared', 'api', 'worker', 'web'];
const scopeLabel = {
  shared: 'Shared (API and worker)',
  api: 'API',
  worker: 'Worker',
  web: 'Web (build/dev only)',
};

const rows = (entries) =>
  [
    '| Variable | Required | Default | Purpose | If it is wrong |',
    '| --- | --- | --- | --- | --- |',
    ...entries.map(
      (e) =>
        `| \`${e.name}\`${e.secret ? ' 🔒' : ''} | ${e.required ? 'yes' : 'no'} | ${
          e.default ? `\`${e.default}\`` : '—'
        } | ${e.purpose} | ${e.ifWrong} |`,
    ),
  ].join('\n');

const body = `# Configuration reference

<!-- GENERATED FILE — do not edit by hand.
     Source: apps/api/src/routes/setup/env-registry.ts
     Regenerate: node scripts/generate-config-doc.mjs
     A test fails if this file drifts from the registry, or if a variable is
     read in source without being registered. -->

Every environment variable RepoPulse reads is listed here: what it is for,
whether it is required, its default, and **what breaks if it is wrong** — which
is the column that actually helps at 2am.

🔒 marks a secret. Secrets are never logged, never returned by the API, and
never echoed back by the setup screen.

**Wrong or missing configuration fails at startup**, with a message naming
every variable at fault. The API will not half-boot.

${scopes
  .map((scope) => {
    const entries = registry.filter((e) => e.scope === scope);
    return entries.length === 0 ? '' : `## ${scopeLabel[scope]}\n\n${rows(entries)}\n`;
  })
  .filter(Boolean)
  .join('\n')}
## Generating the secrets

\`\`\`sh
# TOKEN_ENC_KEY — 32 bytes of hex. LOSING THIS makes every stored forge
# credential undecryptable; they have to be re-entered.
openssl rand -hex 32

# SESSION_SECRET — any long random string. Changing it logs everyone out.
openssl rand -base64 48
\`\`\`

See [INSTALL.md](INSTALL.md) for the full walkthrough, including registering
your own GitHub App or Gitea token.
`;

writeFileSync('docs/CONFIG.md', body);
console.log(`docs/CONFIG.md written (${registry.length} variables)`);
