import { describe, expect, it } from 'vitest';
import { distinctImages, extractImageRefs, parseImageRef } from './refs.js';
import { upgradeCandidates, upgradeSuggestion } from './upgrade.js';
import { listTags, pullImage, type ExecFn } from './pull.js';
import { imageFinding } from './findings.js';
import type { DependencyMatch } from '../dependency/matches.js';

describe('image references (W18-34)', () => {
  it('splits registry, repository, tag and digest with docker defaults', () => {
    expect(parseImageRef('node:20-alpine')).toMatchObject({
      registry: 'docker.io',
      repository: 'library/node',
      tag: '20-alpine',
      digest: null,
    });
    expect(parseImageRef('ghcr.io/acme/app@sha256:abc')).toMatchObject({
      registry: 'ghcr.io',
      repository: 'acme/app',
      tag: null,
      digest: 'sha256:abc',
    });
    expect(parseImageRef('localhost:5000/team/x')).toMatchObject({
      registry: 'localhost:5000',
      repository: 'team/x',
      tag: 'latest',
    });
    expect(parseImageRef('acme/api:1.2')).toMatchObject({ registry: 'docker.io', repository: 'acme/api' });
  });

  it('reads Dockerfile FROM lines and accounts for what it cannot pull', () => {
    const { images, skipped } = extractImageRefs([
      {
        path: 'Dockerfile',
        content: [
          'ARG BASE=node:20',
          'FROM --platform=linux/amd64 golang:1.22 AS build',
          'FROM build AS test',
          'FROM ${BASE}',
          'FROM scratch',
          'FROM gcr.io/distroless/static:nonroot',
        ].join('\n'),
      },
    ]);
    expect(images.map((i) => i.ref)).toEqual(['golang:1.22', 'gcr.io/distroless/static:nonroot']);
    expect(images[0]).toMatchObject({ file: 'Dockerfile', line: 2, kind: 'dockerfile' });
    expect(skipped.map((s) => s.reason)).toEqual(['stage', 'variable', 'scratch']);
  });

  it('reads compose and Kubernetes image keys', () => {
    const { images } = extractImageRefs([
      { path: 'docker-compose.yml', content: 'services:\n  db:\n    image: "postgres:16"  # pinned\n  web:\n    build: .\n' },
      {
        path: 'k8s/deploy.yaml',
        content: 'apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - image: ghcr.io/acme/web:1.4.0\n          name: web\n',
      },
    ]);
    expect(images.map((i) => [i.ref, i.kind])).toEqual([
      ['postgres:16', 'compose'],
      ['ghcr.io/acme/web:1.4.0', 'kubernetes'],
    ]);
  });

  it('ignores files that are not image-bearing', () => {
    expect(extractImageRefs([{ path: 'src/app.ts', content: 'FROM x' }]).images).toEqual([]);
  });

  it('groups every place an image is named', () => {
    const { images } = extractImageRefs([
      { path: 'a/Dockerfile', content: 'FROM node:20' },
      { path: 'b/Dockerfile', content: 'FROM node:20' },
    ]);
    expect(distinctImages(images).get('node:20')).toHaveLength(2);
  });
});

describe('base-image upgrade suggestions (W18-34)', () => {
  const tags = ['18-alpine', '20-alpine', '20.1-alpine', '20.11-alpine', '22-alpine', '22-slim', '23.0-rc1-alpine', 'latest'];

  it('keeps the variant and only moves forward', () => {
    const picked = upgradeCandidates('20-alpine', tags);
    expect(picked).toEqual(['20.1-alpine', '20.11-alpine', '22-alpine']);
    expect(picked).not.toContain('22-slim');
  });

  it('offers nothing for a non-version tag', () => {
    expect(upgradeCandidates('latest', tags)).toEqual([]);
  });

  it('suggests only when a candidate does better', () => {
    expect(
      upgradeSuggestion('library/node', '20-alpine', 12, [
        { tag: '20.11-alpine', findings: 4 },
        { tag: '22-alpine', findings: 0 },
        { tag: '21-alpine', findings: null },
      ]),
    ).toBe('Moving library/node:20-alpine to 22-alpine clears all 12 findings.');
    expect(upgradeSuggestion('x', '1', 3, [{ tag: '2', findings: 3 }])).toBeNull();
    expect(upgradeSuggestion('x', '1', 0, [{ tag: '2', findings: 0 }])).toBeNull();
  });
});

describe('host-side pulls (W18-34)', () => {
  it('passes the self-hoster auth file to skopeo and reports failures without throwing', async () => {
    const seen: string[][] = [];
    const exec: ExecFn = async (_file, args) => {
      seen.push([...args]);
      return { code: 0, stdout: '', stderr: '' };
    };
    const ok = await pullImage('node:20', '/scratch', { exec, authFile: '/etc/auth.json' });
    expect(ok).toEqual({ ok: true, archive: '/scratch/image.tar' });
    expect(seen[0]).toEqual([
      'copy',
      '--authfile',
      '/etc/auth.json',
      '--override-os',
      'linux',
      'docker://node:20',
      'docker-archive:/scratch/image.tar',
    ]);
    const bad = await pullImage('x/y:1', '/s', {
      exec: async () => ({ code: 1, stdout: '', stderr: 'unauthorized: authentication required' }),
      authFile: undefined,
    });
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.reason).toMatch(/unauthorized/);
  });

  it('lists tags, and returns null when the registry will not say', async () => {
    const good: ExecFn = async () => ({ code: 0, stdout: '{"Tags":["1","2"]}', stderr: '' });
    expect(await listTags('docker.io', 'library/node', { exec: good })).toEqual(['1', '2']);
    const bad: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'nope' });
    expect(await listTags('docker.io', 'library/node', { exec: bad })).toBeNull();
  });
});

describe('image findings (W18-34)', () => {
  const match = {
    vulnerabilityId: 'GHSA-xxxx',
    cveId: 'CVE-2024-1234',
    severity: 4,
    severityLabel: 'High',
    kev: false,
    epss: 0.02,
    packageName: 'openssl',
    packageVersion: '3.0.1',
    fixVersions: ['3.0.9'],
    matchType: 'exact-direct-match',
  } as unknown as DependencyMatch;
  const image = { ...parseImageRef('node:20'), file: 'Dockerfile', line: 1, kind: 'dockerfile' as const };

  it('files the vulnerability at the Dockerfile line, in the dependency dimension', () => {
    const { finding } = imageFinding(image, match, 'Moving library/node:20 to 22 clears all 3 findings.');
    expect(finding).toMatchObject({
      dimension: 'dependency',
      file: 'Dockerfile',
      lineStart: 1,
      scannerKey: 'container_image',
      ruleId: 'CVE-2024-1234',
      cveId: 'CVE-2024-1234',
      severity: 4,
      confidence: 5,
    });
    expect(finding.suggestedFix).toMatch(/3\.0\.9/);
    expect(finding.suggestedFix).toMatch(/Moving library\/node:20/);
  });

  it('keys the same finding the same way twice, and floors KEV at 4', () => {
    const a = imageFinding(image, match, null);
    const b = imageFinding(image, match, 'a different suggestion');
    expect(a.key).toBe(b.key);
    expect(imageFinding(image, { ...match, kev: true, severity: 2 }, null).finding.severity).toBe(4);
  });
});
