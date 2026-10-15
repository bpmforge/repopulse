// Unused exports (W18-01, CODE_HEALTH_SUITE.md §1 R-25, FR-CH-3).
//
// The backlog's `dead_code` entry waits on knip, and knip needs the
// repository's dependencies installed — which the `--network=none` sandbox
// will never do. This is the part of that analysis that needs NOTHING
// installed: the repository's own import graph, read from source.
//
// TWO SIGNALS MUST AGREE before anything is reported, because a dead-export
// finding is an invitation to delete code and a wrong one costs a revert:
//
//   1. The graph. The module IS imported by another file in the snapshot (so it
//      is live code, not a script or an entry point), every importer names what
//      it takes, and none of them takes this export.
//   2. The text. The name appears in no other file at all. This is what covers
//      the specifiers the graph cannot resolve — tsconfig path aliases,
//      workspace package names, bundler magic — because whatever reached the
//      export through them still had to spell its name.
//
// What this deliberately does not do: report modules nothing imports. A file
// with no importers is as likely to be an entry point, a CLI or a framework
// route as dead code, and the snapshot carries no package.json to tell which.
// JS/TS only — Python and Go have their own idioms and their own tools.

import {
  CODE,
  CONVENTIONAL_NAMES,
  exportsOf,
  importsOf,
  maskSource,
  PUBLIC_SURFACE,
  resolveSpecifier,
} from './source-graph.js';

export { exportsOf, importsOf, maskSource, resolveSpecifier };

export const UNUSED_EXPORT_RULE_ID = 'slop.unused_export';

export interface UnusedExport {
  ruleId: typeof UNUSED_EXPORT_RULE_ID;
  file: string;
  name: string;
  line: number;
  /** The export's own line, verbatim — the evidence quote. */
  declaration: string;
  /** How many files import the module, for the message. */
  importers: number;
  message: string;
}

/** How many files mention each identifier, for the second signal. */
function identifierCounts(texts: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const seen = new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);
    for (const name of seen) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/**
 * Exports of live modules that no other file in the snapshot uses.
 *
 * Both signals described at the top of this file have to agree. The result is
 * sorted by file and line so a re-run on an unchanged tree reports the same
 * list in the same order.
 */
export function unusedExports(files: readonly { path: string; source: string }[]): UnusedExport[] {
  const code = files.filter((f) => CODE.test(f.path));
  const paths = new Set(code.map((f) => f.path));
  const masked = new Map(code.map((f) => [f.path, maskSource(f.source)]));

  // module → what its importers take, and how many importers there are.
  const takenBy = new Map<string, { all: boolean; names: Set<string>; importers: Set<string> }>();
  for (const file of code) {
    for (const { specifier, taken } of importsOf(file.source, masked.get(file.path))) {
      const target = resolveSpecifier(file.path, specifier, paths);
      if (!target || target === file.path) continue;
      const entry = takenBy.get(target) ?? { all: false, names: new Set(), importers: new Set() };
      entry.importers.add(file.path);
      if (taken === 'all') entry.all = true;
      else for (const name of taken) entry.names.add(name);
      takenBy.set(target, entry);
    }
  }

  // Strings kept for both counts: `${name()}` inside a template is a use, and
  // a name in a string may be looked up by it.
  const withStrings = new Map(code.map((f) => [f.path, maskSource(f.source, true)]));
  const mentions = identifierCounts(withStrings.values());
  const out: UnusedExport[] = [];

  for (const file of code) {
    if (PUBLIC_SURFACE.some((re) => re.test(file.path))) continue;
    const taken = takenBy.get(file.path);
    // Not imported by anything we could resolve: maybe dead, maybe an entry
    // point. Not ours to say (see the top of this file).
    if (!taken || taken.all) continue;

    const text = masked.get(file.path) as string;
    for (const decl of exportsOf(file.source, text)) {
      if (CONVENTIONAL_NAMES.has(decl.name) || taken.names.has(decl.name)) continue;

      // Signal two: no other file spells the name. identifierCounts counts
      // files, so anything above 1 means someone else mentioned it.
      if ((mentions.get(decl.name) ?? 0) > 1) continue;
      // And nothing in its own file uses it either. An export used only at
      // home is surface to trim, not dead code — and on a typed codebase it is
      // every props interface, which is the noise that gets a rule muted.
      const escaped = decl.name.replace(/\$/g, '\\$');
      const own = withStrings.get(file.path) as string;
      const ownHits = own.match(new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g'))?.length ?? 0;
      if (ownHits > 1) continue;

      out.push({
        ruleId: UNUSED_EXPORT_RULE_ID,
        file: file.path,
        name: decl.name,
        line: decl.line,
        declaration: decl.declaration,
        importers: taken.importers.size,
        message:
          `${decl.name} is exported and used nowhere: ${taken.importers.size} file(s) import ` +
          'this module, none of them take it, and no file — this one included — mentions the ' +
          'name again. Likely dead code; check for consumers outside this repository before ' +
          'deleting it.',
      });
    }
  }

  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
