import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adaptersFor } from './registry.js';
import {
  iacRenderAdapter,
  isSubchart,
  renderScript,
  renderTargets,
  splitOutput,
} from './iacrender.js';

// Helm and Kustomize rendering (W18-45). The fixtures are real charts and
// overlays; the recorded outputs are what the adapter's shell printed on them
// with helm 3.16.4, kustomize 5.5.0 and checkov 3.3.29 (built from source,
// run on the host at authoring, like fixtures/adapters/recorded for the other
// adapters). The rendering itself runs in the scan image, which must carry
// helm and kustomize: Containerfile.scan.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../../fixtures');
const RECORDED = path.join(FIXTURES, 'adapters/recorded');

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

const ctx = (kind: 'triggering' | 'clean') => {
  const root = path.join(FIXTURES, 'iac-render', kind);
  return { mountPath: '/scan', files: walk(root) };
};
const recorded = (kind: string) => readFileSync(path.join(RECORDED, `iacrender.${kind}.txt`), 'utf8');

describe('what gets rendered', () => {
  it('finds charts and overlays, skips vendored subcharts and pruned directories', () => {
    const t = renderTargets([
      'Chart.yaml',
      'charts/redis/Chart.yaml',
      'deploy/api/Chart.yaml',
      'deploy/api/charts/common/Chart.yaml',
      'node_modules/x/Chart.yaml',
      'k/base/kustomization.yaml',
      'k/o/kustomization.yml',
      'k/o2/Kustomization',
    ]);
    // charts/redis is a sibling of the root chart's templates, i.e. its subchart.
    expect(t.charts.sort()).toEqual(['.', 'deploy/api']);
    expect(t.overlays.sort()).toEqual(['k/base', 'k/o', 'k/o2']);
  });

  it('treats only a chart under a parent chart\'s charts/ as a subchart', () => {
    const all = ['a/Chart.yaml', 'a/charts/b/Chart.yaml', 'c/Chart.yaml'];
    expect(isSubchart('a/charts/b/Chart.yaml', all)).toBe(true);
    expect(isSubchart('a/Chart.yaml', all)).toBe(false);
    expect(isSubchart('c/Chart.yaml', all)).toBe(false);
  });

  it('applies only where there is something to render', () => {
    expect(iacRenderAdapter.detect({ mountPath: '/scan', files: ['main.tf', 'k8s/d.yaml'] })).toBe(false);
    expect(iacRenderAdapter.detect(ctx('triggering'))).toBe(true);
    expect(adaptersFor(ctx('clean')).map((a) => a.key)).toContain('iacrender');
  });
});

describe('the command', () => {
  const script = renderScript('/scan', { charts: ['charts/web', "o'brien"], overlays: ['k/o'] });

  it('renders each target offline, with plugins and network left out', () => {
    expect(script).toContain("helm template release '/scan/charts/web'");
    expect(script).toContain("kustomize build '/scan/k/o'");
    expect(script).not.toMatch(/--enable-helm|--enable-alpha-plugins|--load-restrictor|dependency (build|update)/);
    expect(script).toContain('--framework');
    expect(script).toContain("'kubernetes'");
  });

  it('quotes paths, so a hostile directory name cannot add a command', () => {
    expect(script).toContain(`'/scan/o'\\''brien'`);
    const hostile = renderScript('/scan', { charts: ["x'; rm -rf /; '"], overlays: [] });
    expect(hostile).not.toMatch(/; rm -rf \/; (?!')/);
  });

  it('keeps the renders and helm state on the tmpfs and ignores the repository\'s checkov config', () => {
    expect(script).toContain('R=/tmp/iacrender');
    expect(script).toContain('HELM_CACHE_HOME="$R/.helm/cache"');
    expect(script).toContain('cd / && timeout');
  });
});

describe('the recorded renders', () => {
  it('reads which sources rendered and which failed', () => {
    const parsed = splitOutput(recorded('triggering'));
    expect([...parsed.rendered.values()].map((r) => `${r.kind}:${r.dir}`).sort()).toEqual([
      'chart:charts/web',
      'overlay:kustomize/base',
      'overlay:kustomize/overlays/prod',
    ]);
    expect(parsed.failed).toEqual([{ kind: 'chart', dir: 'charts/needs-deps' }]);
  });

  it('turns rendered misconfigurations into findings on the chart and overlay sources', () => {
    const found = iacRenderAdapter
      .parse(recorded('triggering'), ctx('triggering'))
      .map((f) => `${f.nativeRule} ${f.file}`)
      .sort();
    expect(found).toEqual(
      [
        'CKV_K8S_16 charts/web/Chart.yaml',
        'CKV_K8S_19 charts/web/Chart.yaml',
        'CKV_K8S_20 charts/web/Chart.yaml',
        'CKV_K8S_16 kustomize/overlays/prod/kustomization.yaml',
        'CKV_K8S_17 kustomize/overlays/prod/kustomization.yaml',
        'CKV_K8S_20 kustomize/overlays/prod/kustomization.yaml',
        'CKV_K8S_20 kustomize/base/kustomization.yaml',
        'render-failed charts/needs-deps/Chart.yaml',
      ].sort(),
    );
  });

  it('reports a chart it could not render instead of passing it as clean', () => {
    const failed = iacRenderAdapter
      .parse(recorded('triggering'), ctx('triggering'))
      .find((f) => f.nativeRule === 'render-failed')!;
    expect(failed).toMatchObject({
      ruleId: 'tool.iacrender.render-failed',
      file: 'charts/needs-deps/Chart.yaml',
      dimension: 'iac',
      severity: 1,
    });
    expect(failed.title).toContain('not checked');
  });

  it('points findings at line 1 of the source and names the rendered resource', () => {
    const f = iacRenderAdapter
      .parse(recorded('triggering'), ctx('triggering'))
      .find((x) => x.nativeRule === 'CKV_K8S_16' && x.file === 'charts/web/Chart.yaml')!;
    expect(f).toMatchObject({ lineStart: 1, lineEnd: 1, severity: 4, ruleId: 'tool.iacrender.CKV_K8S_16' });
    expect(f.message).toContain('Deployment.default.release-web');
  });

  it('finds nothing in the safe chart and overlay', () => {
    expect(splitOutput(recorded('clean')).failed).toEqual([]);
    expect(iacRenderAdapter.parse(recorded('clean'), ctx('clean'))).toEqual([]);
  });

  it('is empty for output with no report, never an exception', () => {
    expect(iacRenderAdapter.parse('', ctx('clean'))).toEqual([]);
    expect(iacRenderAdapter.parse('@@CHECKOV\nnot json', ctx('clean'))).toEqual([]);
    expect(iacRenderAdapter.parse('@@FAILED chart x\n', { mountPath: '/s', files: [] })).toHaveLength(1);
  });
});
