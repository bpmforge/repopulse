import { goImports } from '../scanners/anti-slop/go-graph.js';
import { resolveSpecifier } from '../scanners/anti-slop/source-graph.js';
import { looksLikeSecret } from '../excerpt.js';
import type {
  ContextPacket,
  PacketCaller,
  PacketDefinition,
  PacketSegment,
} from '../triage/packet.js';
import {
  declarationsOf,
  enclosingAt,
  importsIn,
  langOf,
  namesOnLines,
  parametersOf,
  pythonModuleCandidates,
  viewOf,
  type Declaration,
  type FileView,
  type Lang,
  type NameRef,
  type Scope,
} from './lexical.js';
import { SnapshotReader } from './snapshot.js';

// Evidence capture for the AI judge (W22-02, slice 1).
//
// While the scan holds the snapshot (C1a: it is deleted after scanning), each
// rule hit gets a compact packet: the enclosing function, where the names on
// the flagged lines are defined (class fields, module constants, parameters,
// one hop through imports), and the enclosing function's callers with
// Lodestone's reliability flag. Stored on the finding beside context_lines and
// cleared with it (insights/findings/context.ts).
//
// Lexical, on the masked text the in-process checks share; callers are matched
// by name, so crossFileGraphReliable is always false here. W22-01 replaces the
// resolver with Lodestone's tree-sitter index and keeps this packet shape.

/** Stored bytes per packet (JSON). Over it, callers, then definitions, then the function are cut. */
export const PACKET_MAX_BYTES = 12_000;
/** A longer enclosing function keeps its head and the lines around the hit. */
export const ENCLOSING_MAX_LINES = 80;
const ENCLOSING_HEAD_LINES = 6;
const ENCLOSING_AROUND = 20;
export const MAX_DEFINITIONS = 12;
export const MAX_CALLERS_SHOWN = 8;
/** Callers counted per symbol; the count is reported as "at least" beyond it. */
export const MAX_CALLERS_COUNTED = 500;
/** Packets built per capture call; findings past it keep context_lines only. */
export const MAX_PACKETS_PER_CALL = 3_000;
const LINE_CHARS = 300;
const TEST_PATH =
  /(^|\/)(__tests__|tests?|spec|e2e|testdata|fixtures?)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.go$/;

export interface PacketTarget {
  file: string;
  lineStart: number;
  lineEnd: number;
}

const clip = (s: string): string => (s.length > LINE_CHARS ? `${s.slice(0, LINE_CHARS)}…` : s);

function segment(view: FileView, from: number, to: number): PacketSegment {
  return {
    startLine: from,
    lines: view.raw
      .slice(from - 1, to)
      .map(clip)
      .join('\n'),
  };
}

function enclosingSegments(
  view: FileView,
  fn: Scope,
  hitStart: number,
  hitEnd: number,
): PacketSegment[] {
  if (fn.endLine - fn.startLine + 1 <= ENCLOSING_MAX_LINES)
    return [segment(view, fn.startLine, fn.endLine)];
  const headEnd = fn.startLine + ENCLOSING_HEAD_LINES - 1;
  const from = Math.max(headEnd + 1, hitStart - ENCLOSING_AROUND);
  const to = Math.min(fn.endLine, hitEnd + ENCLOSING_AROUND);
  if (from <= headEnd + 1) return [segment(view, fn.startLine, to)];
  return [segment(view, fn.startLine, headEnd), segment(view, from, to)];
}

interface CallerRequest {
  lang: Lang;
  symbol: string;
  /** `new X(` in JS-like code, `X(` in Python: a constructor's callers. */
  ctor: boolean;
  file: string;
  /** Lines of the function's own declaration, never a caller of it. */
  ownFrom: number;
  ownTo: number;
}

interface Draft {
  packet: ContextPacket;
  callers: CallerRequest | null;
}

const goPackageName = (p: string): string => {
  const parts = p.split('/');
  const last = parts.at(-1) as string;
  return /^v\d+$/.test(last) && parts.length > 1 ? (parts.at(-2) as string) : last;
};

class Capture {
  private readonly views = new Map<string, FileView | null>();
  private goMods: Map<string, string | null> = new Map();

  constructor(readonly reader: SnapshotReader) {}

  async view(file: string): Promise<FileView | null> {
    if (this.views.has(file)) return this.views.get(file) ?? null;
    const text = await this.reader.read(file);
    const v = text === null ? null : viewOf(file, text);
    this.views.set(file, v);
    return v;
  }

  /** The module path of the go.mod governing `file`, and that go.mod's directory. */
  private async goModule(file: string): Promise<{ module: string; dir: string } | null> {
    const parts = file.split('/').slice(0, -1);
    for (let n = parts.length; n >= 0; n--) {
      const dir = parts.slice(0, n).join('/');
      const key = dir;
      if (!this.goMods.has(key)) {
        const text = await this.reader.read(dir ? `${dir}/go.mod` : 'go.mod');
        this.goMods.set(key, text === null ? null : (/^module\s+(\S+)/m.exec(text)?.[1] ?? null));
      }
      const mod = this.goMods.get(key);
      if (mod) return { module: mod, dir };
    }
    return null;
  }

  private async firstDeclaration(
    files: readonly string[],
    name: string,
  ): Promise<{ file: string; decl: Declaration } | null> {
    for (const f of files) {
      if (!(await this.reader.has(f))) continue;
      const v = await this.view(f);
      if (!v) continue;
      const found = declarationsOf(v, { name, owner: null }, { max: 1 }).filter(
        (d) => d.kind !== 'variable' || v.lang === 'go',
      );
      if (found[0]) return { file: f, decl: found[0] };
    }
    return null;
  }

  /** One hop through an import: where `name` (as the module exports it) is declared. */
  private async throughImport(
    view: FileView,
    ref: NameRef,
    imports: Map<string, { imported: string; specifier: string }>,
    goPkgs: Map<string, string>,
  ): Promise<{ def: PacketDefinition | null; note: string | null }> {
    const label = ref.label;
    if (view.lang === 'go') {
      const importPath = ref.owner ? goPkgs.get(ref.owner) : undefined;
      if (!importPath) return { def: null, note: null };
      const mod = await this.goModule(view.file);
      if (!mod || (importPath !== mod.module && !importPath.startsWith(`${mod.module}/`))) {
        return ref.call
          ? { def: null, note: null }
          : {
              def: null,
              note: `from package "${importPath}" (outside this repository; not followed)`,
            };
      }
      const rel = importPath.slice(mod.module.length).replace(/^\//, '');
      const dir = [mod.dir, rel].filter(Boolean).join('/');
      const files = (await this.reader.list()).filter(
        (f) =>
          f.startsWith(dir ? `${dir}/` : '') &&
          !f.slice(dir ? dir.length + 1 : 0).includes('/') &&
          /\.go$/.test(f) &&
          !/_test\.go$/.test(f),
      );
      const hit = await this.firstDeclaration(files, ref.name);
      return hit
        ? {
            def: {
              name: label,
              kind: hit.decl.kind,
              file: hit.file,
              line: hit.decl.line,
              text: hit.decl.text,
              via: `package "${importPath}"`,
            },
            note: null,
          }
        : {
            def: null,
            note: `from package "${importPath}"; no declaration of ${ref.name} found in ${dir || '.'}`,
          };
    }

    // JS/TS and Python: a plain name bound by an import, or a member of an imported module.
    const key = ref.owner ?? ref.name;
    const imp = imports.get(key);
    if (!imp) return { def: null, note: null };
    let specifier = imp.specifier;
    let wanted = ref.owner ? ref.name : imp.imported;
    if (ref.owner) {
      if (imp.imported !== '*') {
        // `from pkg import mod` then `mod.X`: the module is pkg.mod.
        if (view.lang !== 'py') return { def: null, note: null };
        specifier = specifier.endsWith('.')
          ? `${specifier}${imp.imported}`
          : `${specifier}.${imp.imported}`;
      }
      wanted = ref.name;
    } else if (imp.imported === '*') {
      return { def: null, note: null };
    }
    let candidates: string[];
    if (view.lang === 'py') {
      const all = pythonModuleCandidates(view.file, specifier);
      candidates = all;
      if (!specifier.startsWith('.')) {
        const tail = `/${all[0]}`;
        const deeper = (await this.reader.list()).find((f) => f.endsWith(tail));
        if (deeper) candidates = [...all, deeper];
      }
    } else {
      const resolved = resolveSpecifier(view.file, specifier, await this.reader.set());
      candidates = resolved ? [resolved] : [];
    }
    if (
      candidates.length === 0 ||
      !(await Promise.all(candidates.map((c) => this.reader.has(c)))).some(Boolean)
    ) {
      return {
        def: null,
        note: `imported from "${imp.specifier}" (a package or path alias outside the files read; not followed)`,
      };
    }
    if (wanted === 'default') {
      for (const c of candidates) {
        const v = await this.view(c);
        const line = v?.masked.findIndex((l) => /\bexport\s+default\b/.test(l)) ?? -1;
        if (v && line >= 0) {
          return {
            def: {
              name: label,
              kind: 'imported',
              file: c,
              line: line + 1,
              text: clip(v.raw[line] ?? ''),
              via: `default export of "${imp.specifier}"`,
            },
            note: null,
          };
        }
      }
      return {
        def: null,
        note: `default import from "${imp.specifier}"; its export was not found`,
      };
    }
    const hit = await this.firstDeclaration(candidates, wanted);
    return hit
      ? {
          def: {
            name: label,
            kind: hit.decl.kind,
            file: hit.file,
            line: hit.decl.line,
            text: hit.decl.text,
            via: `imported from "${imp.specifier}"`,
          },
          note: null,
        }
      : {
          def: null,
          note: `imported from "${imp.specifier}"; no declaration of ${wanted} found there`,
        };
  }

  async draft(t: PacketTarget): Promise<Draft | null> {
    const view = await this.view(t.file);
    if (!view || t.lineStart < 1 || t.lineStart > view.raw.length) return null;
    const hitEnd = Math.min(view.raw.length, Math.max(t.lineStart, t.lineEnd));
    const enc = enclosingAt(view, t.lineStart);

    const enclosing: ContextPacket['enclosing'] = enc.fn
      ? {
          name: enc.fn.name,
          file: t.file,
          startLine: enc.fn.startLine,
          endLine: enc.fn.endLine,
          segments: enclosingSegments(view, enc.fn, t.lineStart, hitEnd),
        }
      : null;
    const shown = (line: number): boolean =>
      (line >= t.lineStart && line <= hitEnd) ||
      (enclosing?.segments.some(
        (s) => line >= s.startLine && line < s.startLine + s.lines.split('\n').length,
      ) ??
        false);

    const imports = new Map<string, { imported: string; specifier: string }>();
    for (const i of importsIn(view))
      imports.set(i.local, { imported: i.imported, specifier: i.specifier });
    const goPkgs = new Map<string, string>();
    if (view.lang === 'go') {
      for (const g of goImports(view.raw.join('\n'))) {
        if (g.alias === '_' || g.alias === '.') continue;
        goPkgs.set(g.alias ?? goPackageName(g.path), g.path);
      }
    }
    const owners = new Set<string>([
      ...[...imports.entries()]
        .filter(([, v]) => v.imported === '*' || view.lang === 'py')
        .map(([k]) => k),
      ...goPkgs.keys(),
    ]);
    const refs = namesOnLines(view, t.lineStart, hitEnd, owners);
    const params = enc.fn ? parametersOf(view, enc.fn) : new Map<string, number>();

    const values: PacketDefinition[] = [];
    const callees: PacketDefinition[] = [];
    const unresolved: ContextPacket['unresolved'] = [];
    for (const ref of refs) {
      const bucket = ref.call ? callees : values;
      if (ref.owner === null && params.has(ref.name)) {
        const line = params.get(ref.name) as number;
        values.push({
          name: ref.label,
          kind: 'parameter',
          file: t.file,
          line,
          text: clip(view.raw[line - 1] ?? ''),
        });
        continue;
      }
      const member = ref.owner === 'this' || ref.owner === 'self';
      if (ref.owner === null || member) {
        const decls = declarationsOf(view, ref, {
          cls: enc.cls,
          skip: (line) => !member && shown(line),
          max: 2,
        });
        if (decls.length > 0) {
          for (const d of decls)
            bucket.push({
              name: ref.label,
              kind: d.kind,
              file: t.file,
              line: d.line,
              text: d.text,
            });
          continue;
        }
        if (member) {
          if (enc.cls && !ref.call) {
            unresolved.push({
              name: ref.label,
              note: `no declaration or assignment found in ${enc.cls.name ?? 'the enclosing class'} (may be inherited or set elsewhere)`,
            });
          }
          continue;
        }
        // A local declared inside the lines already shown needs no entry.
        if (declarationsOf(view, ref, { max: 1 }).length > 0) continue;
      }
      const through = await this.throughImport(view, ref, imports, goPkgs);
      if (through.def) bucket.push(through.def);
      else if (through.note && !ref.call) unresolved.push({ name: ref.label, note: through.note });
    }

    let callers: CallerRequest | null = null;
    const target = enc.named;
    if (target?.name) {
      const ctor = target.name === 'constructor' || target.name === '__init__';
      const symbol = ctor ? (enc.cls?.name ?? null) : target.name;
      if (symbol && symbol.length >= 3) {
        const bodyOpen =
          target.startLine + Math.max(0, target.header.trim().split('\n').length - 1);
        callers = {
          lang: view.lang,
          symbol,
          ctor,
          file: t.file,
          ownFrom: target.startLine,
          ownTo: bodyOpen,
        };
      }
    }

    const packet: ContextPacket = {
      v: 1,
      enclosing,
      definitions: [...values, ...callees],
      unresolved,
      callers: null,
      omitted: [],
    };
    if (packet.definitions.length > MAX_DEFINITIONS) {
      const cut = packet.definitions.splice(MAX_DEFINITIONS);
      packet.omitted.push(`${cut.length} more definitions (${cut.map((d) => d.name).join(', ')})`);
    }
    return { packet, callers };
  }

  /** One pass over the snapshot's files per language: every name-matched call of a wanted symbol. */
  async findCallers(requests: readonly CallerRequest[]): Promise<Map<string, PacketCaller[]>> {
    const found = new Map<string, PacketCaller[]>();
    const wanted = new Map<Lang, Map<string, { ctor: boolean }>>();
    for (const r of requests) {
      const m = wanted.get(r.lang) ?? new Map<string, { ctor: boolean }>();
      m.set(r.symbol, { ctor: r.ctor || m.get(r.symbol)?.ctor === true });
      wanted.set(r.lang, m);
    }
    if (wanted.size === 0) return found;
    for (const file of await this.reader.list()) {
      const lang = langOf(file);
      const symbols = lang ? wanted.get(lang) : undefined;
      if (!lang || !symbols) continue;
      const text = await this.reader.read(file);
      if (text === null) continue;
      const view = viewOf(file, text, lang);
      if (!view) continue;
      view.masked.forEach((line, i) => {
        if (!line.includes('(')) return;
        for (const m of line.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
          const sym = m[1] as string;
          const want = symbols.get(sym);
          if (!want) continue;
          const at = m.index ?? 0;
          if (/[\w$]/.test(line[at - 1] ?? '')) continue;
          const before = line.slice(0, at);
          if (
            /\b(?:function|def|func|fn|fun|class|new\s+function)\s*\*?\s*(?:\([^)]*\)\s*)?$/.test(
              before,
            )
          )
            continue;
          if (want.ctor && lang !== 'py' && !/\bnew\s+$/.test(before)) continue;
          // A method declaration (`  name(args) {`), not a call.
          if (
            /^\s*(?:(?:public|private|protected|static|async|override|abstract|final|synchronized|virtual|internal|open|suspend)\s+)*(?:[\w<>[\],.?]+\s+)?$/.test(
              before,
            ) &&
            /\)\s*(?::[^{;]*|throws[^{;]*|->[^{;]*)?\{\s*$/.test(line)
          )
            continue;
          const key = `${lang}:${sym}`;
          const list = found.get(key) ?? [];
          if (list.length < MAX_CALLERS_COUNTED)
            list.push({ symbol: sym, file, line: i + 1, text: clip((view.raw[i] ?? '').trim()) });
          found.set(key, list);
          break;
        }
      });
    }
    return found;
  }
}

/** Drops pieces that look like they hold a credential; says so in `omitted`. */
function withoutSecrets(p: ContextPacket): ContextPacket {
  const omitted = [...p.omitted];
  let enclosing = p.enclosing;
  if (enclosing && enclosing.segments.some((s) => looksLikeSecret(s.lines))) {
    enclosing = null;
    omitted.push('the enclosing function (it looks like it holds a credential)');
  }
  const definitions = p.definitions.filter((d) => {
    const bad = looksLikeSecret(d.text);
    if (bad) omitted.push(`the definition of ${d.name} (it looks like it holds a credential)`);
    return !bad;
  });
  const callers = p.callers
    ? { ...p.callers, shown: p.callers.shown.filter((c) => !looksLikeSecret(c.text)) }
    : null;
  return { ...p, enclosing, definitions, callers, omitted };
}

/** Cuts the packet to PACKET_MAX_BYTES: callers, then definitions, then the function. */
export function fitPacket(p: ContextPacket, maxBytes = PACKET_MAX_BYTES): ContextPacket {
  const out: ContextPacket = structuredClone(p);
  const size = (): number => Buffer.byteLength(JSON.stringify(out), 'utf8');
  while (size() > maxBytes) {
    if (out.callers && out.callers.shown.length > 2) {
      out.callers.shown.pop();
    } else if (out.definitions.length > 3) {
      const d = out.definitions.pop()!;
      out.omitted.push(`the definition of ${d.name} (${d.file}:${d.line})`);
    } else if (out.enclosing && out.enclosing.segments.length > 1) {
      out.enclosing.segments = out.enclosing.segments.slice(-1);
      out.omitted.push(`the start of the enclosing function (lines ${out.enclosing.startLine}-…)`);
    } else if (out.enclosing) {
      out.omitted.push(
        `the enclosing function (lines ${out.enclosing.startLine}-${out.enclosing.endLine})`,
      );
      out.enclosing = null;
    } else if (out.definitions.length > 0) {
      const d = out.definitions.pop()!;
      out.omitted.push(`the definition of ${d.name} (${d.file}:${d.line})`);
    } else if (out.callers && out.callers.shown.length > 0) {
      out.callers.shown.pop();
    } else {
      break;
    }
  }
  return out;
}

/**
 * Packets for `targets`, same order; null where there is nothing to say (an
 * unreadable or unsupported file, a line past its end). Never throws: a
 * failure here costs the judge some context, never the scan.
 */
export async function capturePackets(
  dir: string,
  targets: readonly (PacketTarget | null)[],
): Promise<(ContextPacket | null)[]> {
  try {
    const cap = new Capture(new SnapshotReader(dir));
    const drafts: (Draft | null)[] = [];
    let built = 0;
    for (const t of targets) {
      if (!t || built >= MAX_PACKETS_PER_CALL || !langOf(t.file)) {
        drafts.push(null);
        continue;
      }
      drafts.push(await cap.draft(t).catch(() => null));
      built += 1;
    }
    const requests = drafts.flatMap((d) => (d?.callers ? [d.callers] : []));
    const callers = await cap.findCallers(requests);
    return drafts.map((d) => {
      if (!d) return null;
      const r = d.callers;
      if (r) {
        const all = (callers.get(`${r.lang}:${r.symbol}`) ?? []).filter(
          (c) => !(c.file === r.file && c.line >= r.ownFrom && c.line <= r.ownTo),
        );
        // Same file first, then product code, then tests: a test calling the
        // function says little about what real callers pass it.
        const rank = (c: PacketCaller): number =>
          c.file === r.file ? 0 : TEST_PATH.test(c.file) ? 2 : 1;
        all.sort((a, b) => rank(a) - rank(b));
        d.packet.callers = {
          symbol: r.symbol,
          shown: all.slice(0, MAX_CALLERS_SHOWN),
          total: all.length,
          crossFileGraphReliable: false,
          method: 'name-match',
        };
      }
      const p = withoutSecrets(d.packet);
      const empty =
        !p.enclosing && p.definitions.length === 0 && p.unresolved.length === 0 && !p.callers;
      return empty ? null : fitPacket(p);
    });
  } catch {
    return targets.map(() => null);
  }
}
