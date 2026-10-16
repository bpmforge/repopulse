import { addNode, newGraph, nodeId, normalizeName, type DepGraph } from './graph.js';

// Lockfile readers for fix paths (W18-36). Pure: text in, graph out.
//
// These are deliberately line-oriented readers for formats whose lockfile
// shape is regular and machine-written, rather than full YAML/TOML parsers: the
// security package takes no new dependency for this, and each reader is pinned
// by a fixture tree. A lockfile a reader cannot make sense of returns null and
// the advice says the graph was unreadable — it never invents a path.

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '');
const indentOf = (line: string): number => line.length - line.trimStart().length;

// ---- npm package-lock.json v2/v3 ------------------------------------------

export function readNpmGraph(text: string, manifest: string): DepGraph | null {
  const packages = asRecord(asRecord(JSON.parse(text))['packages']);
  if (Object.keys(packages).length === 0) return null;
  const graph = newGraph('npm', manifest, 'npm');
  const nameOf = (p: string): string => p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const resolve = (from: string, name: string): string | null => {
    let base = from;
    for (;;) {
      const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
      if (candidate in packages) return candidate;
      if (base === '') return null;
      const at = base.lastIndexOf('/node_modules/');
      base = at === -1 ? '' : base.slice(0, at);
    }
  };
  const idOfPath = (p: string): string | null => {
    const entry = asRecord(packages[p]);
    return typeof entry['version'] === 'string' ? nodeId(nameOf(p), entry['version']) : null;
  };
  for (const [p, value] of Object.entries(packages)) {
    if (p === '' || !p.includes('node_modules/')) continue;
    const entry = asRecord(value);
    if (typeof entry['version'] !== 'string') continue;
    const node = addNode(graph, nameOf(p), entry['version']);
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(asRecord(entry[field]))) {
        const resolved = resolve(p, dep);
        const id = resolved ? idOfPath(resolved) : null;
        if (id && !node.deps.includes(id)) node.deps.push(id);
      }
    }
  }
  const root = asRecord(packages['']);
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(asRecord(root[field]))) {
      const resolved = resolve('', dep);
      const id = resolved ? idOfPath(resolved) : null;
      if (id && !graph.roots.includes(id)) graph.roots.push(id);
    }
  }
  return graph;
}

// ---- pnpm-lock.yaml (v6 and v9) --------------------------------------------

/** `name@1.2.3(peer@1)` or `/name@1.2.3` -> [name, 1.2.3]. */
function pnpmKey(raw: string): [string, string] | null {
  const key = unquote(raw).replace(/^\//, '').replace(/\(.*$/, '');
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  return [key.slice(0, at), key.slice(at + 1)];
}

export function readPnpmGraph(text: string, manifest: string): DepGraph | null {
  const lines = text.split(/\r?\n/);
  const graph = newGraph('npm', manifest, 'pnpm');
  let section = '';
  let entry: [string, string] | null = null;
  let field = '';
  let importerField = '';
  let importerName: string | null = null;
  let sawSnapshot = false;

  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = indentOf(line);
    const body = line.trim();
    if (indent === 0) {
      section = body.replace(/:.*$/, '');
      entry = null;
      field = '';
      continue;
    }
    if (section === 'importers') {
      if (indent === 4 && /^(dependencies|devDependencies|optionalDependencies):/.test(body)) {
        importerField = body;
        importerName = null;
      } else if (indent === 2) {
        importerField = '';
      } else if (importerField !== '') {
        if (indent === 6) {
          const [name, inline] = splitKeyValue(body);
          importerName = name;
          if (inline !== '') pushRoot(graph, name, inline);
        } else if (indent === 8 && importerName && body.startsWith('version:')) {
          pushRoot(graph, importerName, unquote(body.slice('version:'.length)));
        }
      }
    } else if (section === 'snapshots' || section === 'packages') {
      if (indent === 2 && (body.endsWith(':') || body.endsWith(': {}'))) {
        entry = pnpmKey(body.replace(/:( \{\})?$/, ''));
        field = '';
        if (entry) {
          addNode(graph, entry[0], entry[1]);
          if (section === 'snapshots') sawSnapshot = true;
        }
      } else if (entry && indent === 4) {
        field = /^(dependencies|optionalDependencies):/.test(body) ? 'deps' : '';
      } else if (entry && indent === 6 && field === 'deps') {
        const [name, version] = splitKeyValue(body);
        const dep = pnpmKey(`${name}@${version}`);
        if (dep) {
          const node = addNode(graph, entry[0], entry[1]);
          const id = nodeId(dep[0], dep[1]);
          if (!node.deps.includes(id)) node.deps.push(id);
        }
      }
    }
  }
  // v6 keeps the graph in `packages`; v9 in `snapshots`. Either way something was read.
  if (graph.nodes.size === 0 || (!sawSnapshot && graph.roots.length === 0)) return null;
  return graph;
}

function splitKeyValue(body: string): [string, string] {
  const at = body.indexOf(': ');
  if (at === -1) return [unquote(body.replace(/:$/, '')), ''];
  return [unquote(body.slice(0, at)), unquote(body.slice(at + 2))];
}

function pushRoot(graph: DepGraph, name: string, rawVersion: string): void {
  const version = rawVersion.replace(/\(.*$/, '');
  const id = nodeId(name, version);
  if (!graph.roots.includes(id)) graph.roots.push(id);
}

// ---- yarn.lock v1 ----------------------------------------------------------

export function readYarnGraph(text: string, manifest: string, packageJson: string | null): DepGraph | null {
  if (!/^# yarn lockfile v1/m.test(text)) return null;
  const graph = newGraph('npm', manifest, 'yarn');
  const bySpec = new Map<string, string>();
  const pending: { id: string; deps: [string, string][] }[] = [];
  let specs: string[] = [];
  let current: { id: string; deps: [string, string][] } | null = null;
  let inDeps = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const indent = indentOf(line);
    const body = line.trim();
    if (indent === 0 && body.endsWith(':')) {
      specs = body.slice(0, -1).split(',').map(unquote);
      current = null;
      inDeps = false;
    } else if (indent === 2 && body.startsWith('version ')) {
      const version = unquote(body.slice('version '.length));
      const at = specs[0] ? specs[0].lastIndexOf('@') : -1;
      if (at <= 0) continue;
      const name = specs[0]!.slice(0, at);
      addNode(graph, name, version);
      const id = nodeId(name, version);
      for (const spec of specs) bySpec.set(spec, id);
      current = { id, deps: [] };
      pending.push(current);
      inDeps = false;
    } else if (indent === 2) {
      inDeps = /^(dependencies|optionalDependencies):$/.test(body);
    } else if (indent === 4 && inDeps && current) {
      const m = /^("[^"]+"|\S+)\s+(.+)$/.exec(body);
      if (m) current.deps.push([unquote(m[1]!), unquote(m[2]!)]);
    }
  }
  for (const p of pending) {
    const node = graph.nodes.get(p.id)!;
    for (const [name, range] of p.deps) {
      const id = bySpec.get(`${name}@${range}`);
      if (id && !node.deps.includes(id)) node.deps.push(id);
    }
  }
  if (graph.nodes.size === 0) return null;
  if (packageJson) {
    const pkg = asRecord(JSON.parse(packageJson));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(asRecord(pkg[field]))) {
        const id = bySpec.get(`${name}@${String(range)}`);
        if (id && !graph.roots.includes(id)) graph.roots.push(id);
      }
    }
  }
  if (graph.roots.length === 0) rootsFromInbound(graph);
  return graph;
}

/** Fallback when the manifest naming the direct dependencies is absent: nothing depends on a root. */
export function rootsFromInbound(graph: DepGraph): void {
  const inbound = new Set<string>();
  for (const node of graph.nodes.values()) for (const d of node.deps) inbound.add(d);
  graph.roots = [...graph.nodes.keys()].filter((id) => !inbound.has(id));
}

// ---- TOML lockfiles: poetry.lock, uv.lock, Cargo.lock -----------------------

interface TomlPackage {
  name: string;
  version: string;
  source: string;
  deps: string[];
  raw: string;
}

function tomlPackages(text: string): TomlPackage[] {
  const out: TomlPackage[] = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (!name || !version) continue;
    const source = /^source\s*=\s*(.+)$/m.exec(block)?.[1] ?? '';
    out.push({ name, version, source, deps: [], raw: block });
  }
  return out;
}

export function readPoetryGraph(text: string, manifest: string, pyproject: string | null): DepGraph | null {
  const packages = tomlPackages(text);
  if (packages.length === 0) return null;
  const graph = newGraph('pypi', manifest, 'poetry');
  const byName = new Map<string, string>();
  for (const p of packages) {
    addNode(graph, p.name, p.version);
    byName.set(normalizeName('pypi', p.name), nodeId(p.name, p.version));
  }
  for (const p of packages) {
    const table = /^\[package\.dependencies\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(p.raw)?.[1] ?? '';
    for (const m of table.matchAll(/^\s*"?([A-Za-z0-9_.-]+)"?\s*=/gm)) {
      const id = byName.get(normalizeName('pypi', m[1]!));
      const node = graph.nodes.get(nodeId(p.name, p.version))!;
      if (id && !node.deps.includes(id)) node.deps.push(id);
    }
  }
  const direct = pyproject ? pyprojectDirectNames(pyproject) : [];
  for (const name of direct) {
    const id = byName.get(normalizeName('pypi', name));
    if (id && !graph.roots.includes(id)) graph.roots.push(id);
  }
  if (graph.roots.length === 0) rootsFromInbound(graph);
  return graph;
}

/** Names a pyproject.toml asks for: `[tool.poetry*dependencies]` keys and PEP 621 lists. */
export function pyprojectDirectNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/^\[tool\.poetry(?:\.group\.[\w-]+)?\.(?:dev-)?dependencies\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) {
    for (const k of m[1]!.matchAll(/^\s*"?([A-Za-z0-9_.-]+)"?\s*=/gm)) {
      if (k[1]!.toLowerCase() !== 'python') names.add(k[1]!);
    }
  }
  for (const m of text.matchAll(/^(?:dependencies|dev-dependencies)\s*=\s*\[([\s\S]*?)^\]|^dependencies\s*=\s*\[([^\]]*)\]/gm)) {
    for (const k of (m[1] ?? m[2] ?? '').matchAll(/"\s*([A-Za-z0-9_.-]+)/g)) names.add(k[1]!);
  }
  return [...names];
}

export function readUvGraph(text: string, manifest: string): DepGraph | null {
  const packages = tomlPackages(text);
  if (packages.length === 0) return null;
  const graph = newGraph('pypi', manifest, 'uv');
  const byName = new Map<string, string>();
  const locals: TomlPackage[] = [];
  for (const p of packages) {
    addNode(graph, p.name, p.version);
    byName.set(normalizeName('pypi', p.name), nodeId(p.name, p.version));
    if (/virtual|editable/.test(p.source)) locals.push(p);
  }
  const depsOf = (p: TomlPackage, fields: RegExp): string[] => {
    const out: string[] = [];
    for (const m of p.raw.matchAll(fields)) {
      for (const k of m[1]!.matchAll(/name\s*=\s*"([^"]+)"/g)) out.push(k[1]!);
    }
    return out;
  };
  const main = /^dependencies\s*=\s*\[([\s\S]*?)^\]/gm;
  for (const p of packages) {
    const node = graph.nodes.get(nodeId(p.name, p.version))!;
    for (const name of depsOf(p, main)) {
      const id = byName.get(normalizeName('pypi', name));
      if (id && !node.deps.includes(id)) node.deps.push(id);
    }
  }
  const everything = /^(?:dependencies|dev-dependencies\.\w+|\w+)\s*=\s*\[([\s\S]*?)^\]/gm;
  for (const local of locals) {
    for (const name of [...depsOf(local, everything), ...depsOf(local, /^\s*(?:dev|test|docs)\s*=\s*\[([\s\S]*?)^\]/gm)]) {
      const id = byName.get(normalizeName('pypi', name));
      if (id && !graph.roots.includes(id)) graph.roots.push(id);
    }
  }
  if (graph.roots.length === 0) rootsFromInbound(graph);
  return graph;
}

export function readCargoGraph(text: string, manifest: string): DepGraph | null {
  const packages = tomlPackages(text);
  if (packages.length === 0) return null;
  const graph = newGraph('cargo', manifest, 'cargo');
  for (const p of packages) addNode(graph, p.name, p.version);
  const resolve = (spec: string): string | null => {
    const [name, version] = spec.split(' ');
    if (!name) return null;
    if (version) {
      const id = nodeId(name, version);
      return graph.nodes.has(id) ? id : null;
    }
    const candidates = packages.filter((p) => p.name === name);
    return candidates.length === 1 ? nodeId(name, candidates[0]!.version) : null;
  };
  for (const p of packages) {
    const node = graph.nodes.get(nodeId(p.name, p.version))!;
    const list = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(p.raw)?.[1] ?? '';
    for (const m of list.matchAll(/"([^"]+)"/g)) {
      const id = resolve(m[1]!);
      if (id && !node.deps.includes(id)) node.deps.push(id);
    }
    // A crate with no `source` is one of this workspace's own; what it depends
    // on is what the project depends on directly.
    if (p.source === '') {
      for (const d of node.deps) if (!graph.roots.includes(d)) graph.roots.push(d);
    }
  }
  return graph;
}

// ---- go.mod -----------------------------------------------------------------

/** Flat: Go has no per-package edges in go.mod, only direct vs `// indirect`. */
export function readGoModGraph(text: string, manifest: string): DepGraph | null {
  const graph = newGraph('go', manifest, 'gomod', false);
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const m = inBlock
      ? /^(\S+)\s+(v\S+)(\s*\/\/\s*indirect)?/.exec(line)
      : /^require\s+(\S+)\s+(v\S+)(\s*\/\/\s*indirect)?/.exec(line);
    if (!m) continue;
    addNode(graph, m[1]!, m[2]!);
    if (!m[3]) graph.roots.push(nodeId(m[1]!, m[2]!));
  }
  return graph.nodes.size === 0 ? null : graph;
}
