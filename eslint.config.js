import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

// docs/ARCHITECTURE.md §3 allowed-dependency matrix — row imports column.
// Keep in sync with that table; validate-arch.sh checks the same law at the
// package.json/grep level, this enforces it at the import-statement level.
const DOMAIN_PACKAGES = [
  'shared',
  'auth',
  'forge',
  'ingest',
  'metrics',
  'analysis',
  'insights',
  'reports',
];

const ALLOWED_DEPS = {
  shared: [],
  auth: ['shared'],
  forge: ['shared', 'auth'],
  ingest: ['shared', 'forge'],
  metrics: ['shared'],
  analysis: ['shared', 'forge'],
  insights: ['shared', 'metrics'],
  reports: ['shared', 'metrics', 'insights'],
};

function restrictedGroup(pkg, message) {
  return { group: [`@repopulse/${pkg}`, `@repopulse/${pkg}/*`], message };
}

function domainPackageBoundary(pkg) {
  const allowed = new Set(ALLOWED_DEPS[pkg]);
  const forbiddenDomain = DOMAIN_PACKAGES.filter((p) => p !== pkg && !allowed.has(p));

  const patterns = [
    ...forbiddenDomain.map((p) =>
      restrictedGroup(
        p,
        `packages/${pkg} may not import @repopulse/${p} — see docs/ARCHITECTURE.md §3 allowed-dependency matrix.`,
      ),
    ),
    restrictedGroup('api', `packages/${pkg} may not import apps/api (CLAUDE.md Law 6).`),
    restrictedGroup('web', `packages/${pkg} may not import apps/web (CLAUDE.md Law 6).`),
  ];

  return {
    files: [`packages/${pkg}/src/**/*.ts`],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns }],
    },
  };
}

const domainPackageBoundaries = DOMAIN_PACKAGES.map(domainPackageBoundary);

const apiBoundary = {
  files: ['apps/api/src/**/*.ts'],
  rules: {
    '@typescript-eslint/no-restricted-imports': [
      'error',
      {
        patterns: [restrictedGroup('web', 'apps/api may not import apps/web (CLAUDE.md Law 6).')],
      },
    ],
  },
};

const webBoundary = {
  files: ['apps/web/src/**/*.{ts,tsx}'],
  rules: {
    '@typescript-eslint/no-restricted-imports': [
      'error',
      {
        // `paths` (exact-match) for the shared barrel, not a `patterns` glob:
        // the barrel is type-only (keeps DB/server code out of the browser
        // bundle, ARCHITECTURE §3), but the pure-schema `@repopulse/shared/
        // url-state` subpath — the only other specifier shared's package.json
        // `exports` map publishes — must be value-importable at runtime for URL
        // view-state validation (DASHBOARD §1, FR-WEB-2). A `patterns` group
        // can't express "restrict the barrel but allow one subpath" (gitignore
        // negation is shadowed by the excluded parent), so the exact `paths`
        // entry restricts only `@repopulse/shared` and lets the subpath through.
        // NOTE: this makes shared's package.json `exports` map the sole gate on
        // what web can value-import — adding a new subpath export re-opens the
        // web boundary for it, so keep exports limited to pure, server-free modules.
        paths: [
          {
            name: '@repopulse/shared',
            allowTypeImports: true,
            message:
              'apps/web may only import @repopulse/shared as a type-only import (docs/ARCHITECTURE.md §3) — it must talk to the rest of the system through /api/v1. (Exception: the runtime-safe `@repopulse/shared/url-state` subpath.)',
          },
        ],
        patterns: [
          ...DOMAIN_PACKAGES.filter((p) => p !== 'shared').map((p) =>
            restrictedGroup(
              p,
              `apps/web may not import @repopulse/${p} directly — it only talks to /api/v1 (docs/ARCHITECTURE.md §3, FR-WEB-*).`,
            ),
          ),
          restrictedGroup(
            'api',
            'apps/web may not import apps/api — HTTP only (docs/ARCHITECTURE.md §3).',
          ),
        ],
      },
    ],
  },
};

// SC-23: forge-sourced strings and LLM evidence must render as text only.
// Plain `no-restricted-syntax` (no eslint-plugin-react dependency needed) -
// matches the JSXAttribute node by name regardless of which element it's on.
const webNoDangerousHtml = {
  files: ['apps/web/**/*.tsx'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
        message:
          'dangerouslySetInnerHTML is banned (SC-23) — forge/LLM-sourced strings must render as text only.',
      },
    ],
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.gen.ts',
      '**/.vite/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  ...domainPackageBoundaries,
  apiBoundary,
  webBoundary,
  webNoDangerousHtml,
);
