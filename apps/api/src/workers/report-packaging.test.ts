import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// PACKAGED REPORT PRINTING DRIFT GATE (W20-02, UX_TODO ADM-42).
//
// A report crosses three containers: the worker prints it with Playwright's
// Chromium by loading the web service, writes the files, and the api serves
// them. On the packaged install all three links were broken while every health
// check passed: the worker image was Alpine (Playwright ships no musl browser),
// api and worker shared no volume, and the printer loaded PUBLIC_BASE_URL,
// which from inside the worker is the worker itself. deploy/smoke-report-pdf.sh
// proves the chain live; this test keeps the files that make it work from
// drifting back, without a container runtime.
//
// Text, not parsed YAML, for the same reason as test/ops/deploy-up.test.ts.

const repoRoot = new URL('../../../../', import.meta.url).pathname;
const read = (rel: string): string => readFileSync(repoRoot + rel, 'utf8');

/** One top-level service's block in a compose file. */
function service(compose: string, name: string): string {
  const start = compose.search(new RegExp(`^ {2}${name}:\\s*$`, 'm'));
  expect(start, `service ${name} not found`).toBeGreaterThan(-1);
  const after = compose.slice(start + 1);
  const end = after.search(/^ {2}[a-z][a-z0-9_-]*:\s*$|^[a-z]/m);
  return end === -1 ? after : after.slice(0, end);
}

/** A Dockerfile stage's body, from its FROM to the next FROM. */
function stage(dockerfile: string, name: string): { from: string; body: string } {
  const m = new RegExp(`^FROM (.*) AS ${name}$`, 'm').exec(dockerfile);
  expect(m, `stage ${name} not found`).not.toBeNull();
  const after = dockerfile.slice(m!.index + m![0].length);
  const end = after.search(/^FROM /m);
  return { from: m![1]!, body: end === -1 ? after : after.slice(0, end) };
}

describe('the worker image can launch the report printer', () => {
  const dockerfile = read('Dockerfile');

  it('is built on a glibc base, because Playwright has no Alpine browser', () => {
    const worker = stage(dockerfile, 'worker');
    // Base images are fully qualified (W22-15): Ubuntu's Podman resolves no short names.
    const node = /^(docker\.io\/library\/)?node:/;
    const base = node.test(worker.from) ? worker.from : stage(dockerfile, worker.from).from;
    expect(base).not.toMatch(/alpine/);
    expect(base).toMatch(/^(docker\.io\/library\/)?node:\S+-(bookworm|trixie)(-slim)?$/);
  });

  it('installs the browser from the playwright in its own tree, at a path app can read', () => {
    const { body } = stage(dockerfile, 'worker');
    expect(body).toMatch(/ENV PLAYWRIGHT_BROWSERS_PATH=\/\S+/);
    expect(body).toMatch(/\.\/node_modules\/\.bin\/playwright install --with-deps/);
    expect(body).toContain('USER app');
  });

  it('runs as the same uid/gid as the Alpine images, which share its volume', () => {
    expect(stage(dockerfile, 'worker').body).toMatch(/--gid 101 app[\s\S]*--uid 100 /);
    expect(stage(dockerfile, 'api').body).toMatch(/addgroup -S app && adduser -S -G app app/);
  });

  it('keeps scan-runner on Alpine, whose podman-remote matches the 5.8 server', () => {
    expect(stage(dockerfile, 'scan-runner').from).toBe('api');
  });
});

describe.each(['deploy/compose.yaml', 'deploy/compose.demo.yaml'])('%s', (file) => {
  const compose = read(file);

  it('mounts one report-data volume at DATA_DIR in both api and worker', () => {
    for (const name of ['api', 'worker']) {
      const block = service(compose, name);
      const mount = /^ {6}- ([a-z-]*reportdata):(\/\S+)$/m.exec(block);
      expect(mount, `${name} does not mount a reportdata volume`).not.toBeNull();
      expect(mount![1]).toMatch(/reportdata$/);
      expect(mount![2]).toBe('/app/.data');
    }
    // DATA_DIR is set once in the demo (the shared app_env anchor), per
    // service in compose.yaml; either way it names the mount point.
    expect(compose.match(/^ {6}DATA_DIR: \/app\/\.data$/gm)?.length).toBeGreaterThanOrEqual(1);
    if (file === 'deploy/compose.yaml') {
      for (const name of ['api', 'worker']) {
        expect(service(compose, name)).toMatch(/^ {6}DATA_DIR: \/app\/\.data$/m);
      }
    }
  });

  it('points the printer at the internal web service, not the public URL', () => {
    expect(service(compose, 'worker')).toMatch(/REPORT_PRINT_BASE_URL: \S*http:\/\/web:8080/);
    expect(service(compose, 'web')).toMatch(/:8080/);
  });
});
