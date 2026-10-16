import { checkovFlags, parseCheckovReport } from './checkov.js';
import { PRUNED_DIRS, type AdapterContext, type AdapterFinding, type ToolAdapter } from './types.js';

// Helm and Kustomize, rendered offline and then checked (W18-45).
//
// A Helm chart or a kustomize overlay is a TEMPLATE: what Kubernetes receives
// only exists once `helm template` or `kustomize build` has run. checkov's own
// helm and kustomize runners shell out to those binaries and, when they are
// missing, skip without a word — so this adapter does the rendering itself,
// where the result can be seen, and hands checkov the plain manifests with its
// `kubernetes` framework, on the same allowlist as every other manifest.
//
// OFFLINE, AND WHAT THAT MEANS. The sandbox has no network. A chart whose
// dependencies are vendored under charts/ renders; one that needs
// `helm dependency build` does not, and neither does an overlay that pulls a
// remote base. That is reported — a finding on the chart that says it could not
// be checked — never as a clean result.
//
// THE FINDINGS POINT AT THE SOURCE. Rendered output has no line numbers worth
// the name (it is generated), so a finding is attributed to the chart's
// Chart.yaml or the overlay's kustomization.yaml at line 1, with the rendered
// resource named in the message.
//
// WHAT RUNS. Chart values are the chart's own defaults; a repository's
// per-environment values files are not applied (which one would be "the"
// deployment is a question the scanner cannot answer). Plugins are off:
// kustomize runs with its defaults, which load no exec plugins and no helm
// inflation, and the load restrictor stays on, so an overlay cannot read files
// outside its own tree.

const CHART_FILE = 'Chart.yaml';
const KUSTOMIZATION_FILES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization'];

/** Where renders land: the scan sandbox's tmpfs, the only writable path. */
const RENDER_DIR = '/tmp/iacrender';

/** Seconds per render and for checkov; every tool shares one container budget. */
const RENDER_TIMEOUT_SECONDS = 60;
const CHECKOV_TIMEOUT_SECONDS = 120;

export const CHART_MARKER = '@@CHART';
export const OVERLAY_MARKER = '@@OVERLAY';
export const FAILED_MARKER = '@@FAILED';
export const REPORT_MARKER = '@@CHECKOV';

const baseName = (file: string): string => file.slice(file.lastIndexOf('/') + 1);
const dirName = (file: string): string =>
  file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';

/**
 * A vendored subchart (charts/<name>/Chart.yaml under another chart) is
 * rendered through its parent; rendering it alone would check it with none of
 * the values the parent gives it.
 */
export function isSubchart(file: string, charts: readonly string[]): boolean {
  const dir = dirName(file);
  return charts.some((other) => {
    const parent = dirName(other);
    const prefix = parent === '.' ? 'charts/' : `${parent}/charts/`;
    return parent !== dir && dir.startsWith(prefix);
  });
}

/** The chart and overlay directories in a snapshot, as relative paths. */
export function renderTargets(files: readonly string[]): { charts: string[]; overlays: string[] } {
  const all = files.filter((f) => !f.split('/').some((seg) => PRUNED_DIRS.includes(seg)));
  const chartFiles = all.filter((f) => baseName(f) === CHART_FILE);
  return {
    charts: chartFiles.filter((f) => !isSubchart(f, chartFiles)).map(dirName),
    overlays: all.filter((f) => KUSTOMIZATION_FILES.includes(baseName(f))).map(dirName),
  };
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The shell run in the sandbox: render every target into RENDER_DIR/<n>/, say
 * which directory each <n> came from (or that it failed), then run checkov once
 * over all of it. Paths are passed in as quoted literals; none is ever spliced
 * into the script unquoted.
 */
export function renderScript(root: string, targets: { charts: string[]; overlays: string[] }): string {
  const lines: string[] = [
    `R=${RENDER_DIR}`,
    'rm -rf "$R"; mkdir -p "$R"',
    // helm writes cache, config and data under HOME unless told otherwise.
    'export HELM_CACHE_HOME="$R/.helm/cache" HELM_CONFIG_HOME="$R/.helm/config" HELM_DATA_HOME="$R/.helm/data"',
    'n=0',
  ];
  const abs = (dir: string): string => (dir === '.' ? root : `${root}/${dir}`);
  for (const dir of targets.charts) {
    lines.push(
      'n=$((n+1)); mkdir "$R/$n"',
      `if timeout ${RENDER_TIMEOUT_SECONDS} helm template release ${q(abs(dir))} --include-crds --skip-tests > "$R/$n/rendered.yaml" 2> "$R/$n/err"; then echo ${q(`${CHART_MARKER} `)}"$n" ${q(dir)}; else echo ${q(`${FAILED_MARKER} chart `)}${q(dir)}; fi`,
    );
  }
  for (const dir of targets.overlays) {
    lines.push(
      'n=$((n+1)); mkdir "$R/$n"',
      `if timeout ${RENDER_TIMEOUT_SECONDS} kustomize build ${q(abs(dir))} > "$R/$n/rendered.yaml" 2> "$R/$n/err"; then echo ${q(`${OVERLAY_MARKER} `)}"$n" ${q(dir)}; else echo ${q(`${FAILED_MARKER} overlay `)}${q(dir)}; fi`,
    );
  }
  lines.push(
    `echo ${REPORT_MARKER}`,
    // Nothing rendered: say so rather than hand checkov an empty directory.
    `if [ -n "$(find "$R" -name rendered.yaml -size +0c 2>/dev/null | head -n 1)" ]; then cd / && timeout ${CHECKOV_TIMEOUT_SECONDS} checkov --directory="$R" ${checkovFlags(['kubernetes']).map(q).join(' ')}; else echo '{}'; fi`,
  );
  return lines.join('\n');
}

interface Parsed {
  /** Render number → source directory and kind. */
  rendered: Map<string, { dir: string; kind: 'chart' | 'overlay' }>;
  failed: { dir: string; kind: 'chart' | 'overlay' }[];
  report: string;
}

export function splitOutput(stdout: string): Parsed {
  const rendered: Parsed['rendered'] = new Map();
  const failed: Parsed['failed'] = [];
  const at = stdout.indexOf(`${REPORT_MARKER}\n`);
  const head = at === -1 ? stdout : stdout.slice(0, at);
  const report = at === -1 ? '' : stdout.slice(at + REPORT_MARKER.length + 1);
  for (const line of head.split('\n')) {
    const m = /^(@@CHART|@@OVERLAY) (\d+) (.+)$/.exec(line);
    if (m) {
      rendered.set(m[2]!, { dir: m[3]!, kind: m[1] === CHART_MARKER ? 'chart' : 'overlay' });
      continue;
    }
    const f = /^@@FAILED (chart|overlay) (.+)$/.exec(line);
    if (f) failed.push({ dir: f[2]!, kind: f[1] as 'chart' | 'overlay' });
  }
  return { rendered, failed, report };
}

const sourceFile = (kind: 'chart' | 'overlay', dir: string, files: readonly string[]): string => {
  const name =
    kind === 'chart'
      ? CHART_FILE
      : (KUSTOMIZATION_FILES.find((k) => files.includes(dir === '.' ? k : `${dir}/${k}`)) ??
        KUSTOMIZATION_FILES[0]!);
  return dir === '.' ? name : `${dir}/${name}`;
};

export const iacRenderAdapter: ToolAdapter = {
  key: 'iacrender',
  version: 'helm+kustomize+checkov',
  license: 'Apache-2.0 (helm, kustomize, checkov)',
  shadow: true,

  detect(ctx: AdapterContext): boolean {
    const t = renderTargets(ctx.files);
    return t.charts.length + t.overlays.length > 0;
  },

  command(ctx: AdapterContext): string[] {
    return ['sh', '-c', renderScript(ctx.mountPath, renderTargets(ctx.files))];
  },

  parse(stdout: string, ctx: AdapterContext): AdapterFinding[] {
    const { rendered, failed, report } = splitOutput(stdout);
    const seen = new Set<string>();
    const out: AdapterFinding[] = [];

    for (const finding of parseCheckovReport(
      report,
      (raw) => {
        // /tmp/iacrender/<n>/rendered.yaml → the source directory of render <n>.
        const abs = typeof raw.file_abs_path === 'string' ? raw.file_abs_path : '';
        const n = new RegExp(`^${RENDER_DIR}/(\\d+)/`).exec(abs)?.[1];
        const src = n ? rendered.get(n) : undefined;
        return src ? sourceFile(src.kind, src.dir, ctx.files) : '';
      },
      'tool.iacrender',
    )) {
      if (finding.file === '') continue;
      // An overlay and the base it builds on render the same resource; one row.
      const key = `${finding.file}\u0000${finding.nativeRule}\u0000${finding.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...finding,
        lineStart: 1,
        lineEnd: 1,
        message: `${finding.message} — rendered from ${finding.file}`,
      });
    }

    for (const f of failed) {
      out.push({
        ruleId: 'tool.iacrender.render-failed',
        file: sourceFile(f.kind, f.dir, ctx.files),
        lineStart: 1,
        lineEnd: 1,
        severity: 1,
        title: `${f.kind === 'chart' ? 'Helm chart' : 'Kustomize overlay'} could not be rendered, so it was not checked`,
        message:
          f.kind === 'chart'
            ? 'helm template failed offline (missing vendored dependencies or an invalid template). Its Kubernetes resources were not scanned.'
            : 'kustomize build failed offline (a remote base, a missing file or invalid YAML). Its Kubernetes resources were not scanned.',
        dimension: 'iac',
        nativeRule: 'render-failed',
      });
    }
    return out;
  },
};
