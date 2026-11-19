import { describe, expect, it } from 'vitest';
import { undeclaredPackages, type PackageManifest } from './undeclared-packages.js';

// Undeclared packages (W27-21). Like the phantom rules, this is only worth
// shipping if it is quiet on code that works, so most cases must NOT fire.

const pkg = (path: string, doc: unknown): PackageManifest => ({
  path,
  text: JSON.stringify(doc, null, 2),
});
const root = pkg('package.json', {
  name: 'sampleco',
  dependencies: { express: '4.16.0', sqlite3: '^5.1.0', '@scope/kit': '1.0.0' },
  devDependencies: { vitest: '^4.0.0', '@types/estree': '^1.0.0', '@types/babel__core': '^7.0.0' },
});
const run = (files: { path: string; source: string }[], manifests: PackageManifest[] = [root]) =>
  undeclaredPackages(files, manifests);

describe('undeclared packages', () => {
  it('reports a require of a package no package.json declares, once per file', () => {
    const found = run([
      {
        path: 'src/services/reportService.js',
        source: [
          'const db = require("sqlite3");',
          'const csv = require("fastcsv-stream-writer-pro");',
          'const again = require("fastcsv-stream-writer-pro/lib/x");',
        ].join('\n'),
      },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ruleId: 'slop.undeclared_package',
      file: 'src/services/reportService.js',
      line: 2,
      name: 'fastcsv-stream-writer-pro',
      manifest: 'package.json',
      statement: 'const csv = require("fastcsv-stream-writer-pro")',
    });
  });

  it('reports ES imports and scoped packages by package name, not by subpath', () => {
    const found = run([
      {
        path: 'src/a.ts',
        source: "import { x } from '@scope/kit/sub';\nimport y from '@ghost/pkg/deep/file.js';",
      },
    ]);
    expect(found.map((f) => [f.name, f.line])).toEqual([['@ghost/pkg', 2]]);
  });

  it('is quiet on declared packages, built-ins, relative paths and non-registry specifiers', () => {
    const found = run([
      {
        path: 'src/a.ts',
        source: [
          "import express from 'express';",
          "import fs from 'fs';",
          "import { readFile } from 'fs/promises';",
          "import path from 'node:path';",
          "import { it } from 'vitest';",
          "import type { Node } from 'estree';",
          "import type { NodePath } from '@babel/core';",
          "import local from './local';",
          "import alias from '@/lib/alias';",
          "import tilde from '~/lib/tilde';",
          "import hash from '#internal/hash';",
          "import svelte from '$lib/store';",
          "import virtual from 'virtual:pwa-register';",
          "import raw from 'raw-loader!./x.txt';",
          "import self from 'sampleco/lib/self';",
        ].join('\n'),
      },
      { path: 'src/local.ts', source: 'export default 1;' },
    ]);
    expect(found).toEqual([]);
  });

  it('counts every package.json above the file, and workspace siblings by name', () => {
    const manifests = [
      pkg('package.json', { name: 'mono', devDependencies: { typescript: '^5' } }),
      pkg('packages/api/package.json', { name: '@mono/api', dependencies: { fastify: '^5' } }),
      pkg('packages/web/package.json', { name: '@mono/web', dependencies: { react: '^19' } }),
    ];
    const found = run(
      [
        {
          path: 'packages/api/src/server.ts',
          source: [
            "import fastify from 'fastify';",
            "import ts from 'typescript';",
            "import { ui } from '@mono/web';",
            "import React from 'react';",
          ].join('\n'),
        },
      ],
      manifests,
    );
    // react is the sibling's dependency, not this package's: a phantom
    // dependency that only resolves while the workspace hoists it.
    expect(found.map((f) => [f.name, f.manifest])).toEqual([
      ['react', 'packages/api/package.json'],
    ]);
  });

  it('is quiet where the answer cannot be known', () => {
    const source = "import ghost from 'ghost-package';";
    // No package.json above the file.
    expect(run([{ path: 'tools/x.ts', source }], [pkg('app/package.json', {})])).toEqual([]);
    // A package.json above the file that does not parse.
    expect(
      run([{ path: 'app/x.ts', source }], [root, { path: 'app/package.json', text: '{ nope' }]),
    ).toEqual([]);
    // Fixtures, declaration files and built output.
    expect(
      run([
        { path: 'test/fixtures/x.ts', source },
        { path: 'types/x.d.ts', source },
        { path: 'dist/x.js', source },
      ]),
    ).toEqual([]);
  });

  it('is quiet on tsconfig path aliases, baseUrl directories and ambient modules', () => {
    const tsconfig: PackageManifest = {
      path: 'tsconfig.json',
      text: '{\n  // comments are legal here\n  "compilerOptions": { "paths": { "@app/*": ["src/*"], "shared": ["src/shared.ts"] } }\n}',
    };
    const found = run(
      [
        {
          path: 'src/a.ts',
          source: [
            "import a from '@app/thing';",
            "import b from 'shared';",
            "import c from 'components/Button';",
            "import d from 'legacy-globals';",
          ].join('\n'),
        },
        { path: 'src/components/Button.ts', source: 'export default 1;' },
        { path: 'src/globals.d.ts', source: "declare module 'legacy-globals';" },
      ],
      [root, tsconfig],
    );
    expect(found).toEqual([]);
  });

  it('treats a require inside try as an optional dependency', () => {
    const found = run([
      {
        path: 'src/a.js',
        source: [
          'let fast;',
          'try {',
          "  fast = require('optional-native-addon');",
          '} catch {',
          '  fast = null; // falls back to the JavaScript path',
          '}',
          "const hard = require('not-optional');",
        ].join('\n'),
      },
    ]);
    expect(found.map((f) => f.name)).toEqual(['not-optional']);
  });

  it('W27-21: is quiet on type-only imports and still reports the runtime import beside them', () => {
    const found = run([
      {
        path: 'app/components/NavLink.tsx',
        source: [
          'import type { LocationDescriptor } from "history";',
          'import { type match, type RouteComponentProps } from "react-router";',
          'export type { Location } from "history";',
          'import {',
          '  type Transform,',
          '} from "@dnd-kit/utilities";',
        ].join('\n'),
      },
      {
        path: 'app/hooks/useActionContext.ts',
        source: [
          'import type { Location } from "history";',
          'import { useHistory, type match } from "react-router";',
          'import { parsePath } from "history";',
        ].join('\n'),
      },
    ]);
    expect(found.map((f) => [f.file, f.name, f.line])).toEqual([
      ['app/hooks/useActionContext.ts', 'react-router', 2],
      ['app/hooks/useActionContext.ts', 'history', 3],
    ]);
  });

  it('ignores a specifier that only appears in a comment or a string', () => {
    const found = run([
      {
        path: 'src/a.js',
        source: "// const x = require('ghost-one');\nconst s = \"require('ghost-two')\";",
      },
    ]);
    expect(found).toEqual([]);
  });
});
