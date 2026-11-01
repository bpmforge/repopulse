import {
  hasExtension,
  relativeTo,
  type AdapterContext,
  type AdapterFinding,
  type ToolAdapter,
} from './types.js';

// cppcheck adapter (W18-15, GPL-3.0-or-later — subprocess only, never linked or
// redistributed modified; see CODE_HEALTH_SUITE.md §10 footnote 1).
//
// Verified against cppcheck 2.22.0 built from the pinned source tarball, run
// over fixtures/adapters/cpp and fixtures/c-cpp/security/triggering; the
// recorded output is fixtures/adapters/cppcheck-2.22.0.xml.
//
// Why cppcheck passes the §10 admission filter at all: it parses source
// WITHOUT a build. No compile_commands.json, no configure step, no headers
// installed — a missing include is a reduced-precision run, not a failure. The
// cost is that macros it cannot see are guessed at, which is why the
// configuration count is capped below and why its parse-failure messages are
// dropped rather than reported as defects in the customer's code.

/** On the sandbox's tmpfs (TMPDIR) — the only writable path a scan has. */
const RESULTS_FILE = '/tmp/cppcheck-results.xml';

/**
 * cppcheck's share of the code-health container's budget (15 minutes by
 * default, run.ts). Leaves room for lizard, jscpd and the other adapters,
 * which run before and after it in the same container.
 */
export const CPPCHECK_TIMEOUT_SECONDS = 480;

/** One single-quoted shell word, so no argument can be re-parsed. */
function shellWord(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export const CPPCHECK_EXTENSIONS = [
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.c++',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
];

/**
 * cppcheck severity → our severity and dimension.
 *
 * `error` is cppcheck's "this is undefined behaviour or a certain bug" class
 * (out-of-bounds, leak, uninitialised read) — real, but a static analyser
 * still did not prove it reachable, so it stays below the 4 the SAST pack
 * reserves for ERROR rules. `style` and `information` are not enabled (see
 * command) and are dropped here too, so a future flag change cannot leak them
 * into the findings list.
 */
const SEVERITY: Record<string, { severity: number; dimension: 'code_health' | 'correctness' }> = {
  error: { severity: 3, dimension: 'correctness' },
  warning: { severity: 2, dimension: 'correctness' },
  portability: { severity: 2, dimension: 'correctness' },
  performance: { severity: 2, dimension: 'code_health' },
};

/**
 * Ids that describe cppcheck's own run, not the customer's code.
 *
 * A `syntaxError` here almost always means a macro the preprocessor could not
 * resolve without the build — reporting it as a defect would tell someone
 * their compiling code does not compile.
 */
const RUN_DIAGNOSTICS = new Set([
  'syntaxError',
  'internalAstError',
  'internalError',
  'cppcheckError',
  'unknownMacro',
  'preprocessorErrorDirective',
  'noValidConfiguration',
  'toomanyconfigs',
  'missingInclude',
  'missingIncludeSystem',
  'checkersReport',
  'normalCheckLevelMaxBranches',
  'unmatchedSuppression',
  'purgedConfiguration',
  'templateRecursion',
  'instantiationError',
]);

/** The XML entities cppcheck emits in attribute values. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|apos|quot|lt|gt|amp);/g, (whole, entity: string) => {
    switch (entity) {
      case 'apos':
        return "'";
      case 'quot':
        return '"';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      default: {
        const code = entity.startsWith('#x')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
    }
  });
}

/** `name="value"` pairs of one start tag. */
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of tag.matchAll(/([A-Za-z_][\w.-]*)="([^"]*)"/g)) {
    out.set(match[1] as string, decodeEntities(match[2] as string));
  }
  return out;
}

export const cppcheckAdapter: ToolAdapter = {
  key: 'cppcheck',
  version: '2.22.0',
  license: 'GPL-3.0-or-later',
  /**
   * Incremental scans (W23-03): 'tree' — whole-program: it checks call and data flow across translation units, so one changed file can change the answer for others.
   */
  scope: 'tree',

  detect(ctx: AdapterContext): boolean {
    return hasExtension(ctx.files, CPPCHECK_EXTENSIONS);
  },

  command(ctx: AdapterContext): string[] {
    const flags = [
      // Defect classes only. `style` is taste (and the bulk of cppcheck's
      // output on real code); `information` is about the run itself;
      // `unusedFunction` needs the whole program and is wrong on a library.
      '--enable=warning,portability,performance',
      // No --inconclusive: those results are cppcheck saying it is guessing,
      // and they are off by default. (There is no `--inconclusive=false` to
      // state that explicitly — 2.22 rejects it as an unknown option and
      // exits without checking anything.)
      //
      // ONE preprocessor configuration. cppcheck otherwise re-checks every
      // file once per #ifdef combination (up to 12), which multiplies the
      // slowest tool in the container by the number of feature flags a
      // repository happens to have, and reports the same defect once per
      // configuration it survives.
      '--max-configs=1',
      // Standard headers are not in the sandbox and do not need to be: the
      // bundled std.cfg describes the library. Without this every file
      // reports that it could not find <stdio.h>.
      '--suppress=missingIncludeSystem',
      // No --inline-suppr and no --project: a repository's own suppression
      // comments and project file must not decide what our scanner reports
      // (same reasoning as ruff's --isolated).
      '-q',
      '--xml',
      `--output-file=${RESULTS_FILE}`,
      ctx.mountPath,
    ];
    // Results go to a FILE on the tmpfs and are cat'd back, because cppcheck
    // writes them to stderr by default and the scanner's shell discards
    // stderr (tools.ts). `--output-file=/dev/stdout` was tried first and
    // produces nothing when stdout is a socket rather than a pipe (Node's
    // child stdio is one) — opening /proc/self/fd/1 fails and cppcheck says
    // nothing. A missing file leaves the section empty, which the scanner
    // reports as an adapter error, never as a clean tree.
    // The rm first, so a results file can only ever be THIS run's.
    //
    // `timeout`, and `&&` before the cat: cppcheck is by far the slowest tool
    // in the container (tens of CPU-minutes on a half-million-line C++ tree,
    // measured on cppcheck's own source), and every tool shares ONE
    // container's wall-clock budget. Unbounded, a large C++ repository would
    // fail the whole code_health_tools run and lose lizard's and jscpd's
    // results with it. Bounded, a cppcheck that runs out of time prints
    // nothing — and an empty section is reported as an adapter error, so a
    // half-finished run never reads as a complete, clean one.
    return [
      'sh',
      '-c',
      `rm -f ${RESULTS_FILE}; timeout ${CPPCHECK_TIMEOUT_SECONDS} cppcheck ${flags.map(shellWord).join(' ')} && cat ${RESULTS_FILE}`,
    ];
  },

  parse(stdout: string, ctx: AdapterContext): AdapterFinding[] {
    const out: AdapterFinding[] = [];
    // A tiny scanner over cppcheck's own, fixed XML shape rather than an XML
    // dependency. It reads `<error …>` start tags and the first `<location>`
    // inside each; anything it cannot read is skipped, never thrown.
    const errorBlock = /<error\s([^>]*?)(\/>|>([\s\S]*?)<\/error>)/g;
    for (const match of stdout.matchAll(errorBlock)) {
      const attrs = attributes(match[1] ?? '');
      const id = attrs.get('id') ?? '';
      const mapped = SEVERITY[attrs.get('severity') ?? ''];
      if (!id || !mapped || RUN_DIAGNOSTICS.has(id)) continue;

      // The FIRST location is where the defect is; later ones are the trail
      // that led there (for nullPointerOutOfMemory, the allocation).
      const locationTag = /<location\s([^>]*?)\/?>/.exec(match[3] ?? '');
      const location = locationTag ? attributes(locationTag[1] ?? '') : new Map<string, string>();
      const file = location.get('file') ?? attrs.get('file0') ?? '';
      if (!file) continue;
      const line = Number.parseInt(location.get('line') ?? '', 10);
      const lineStart = Number.isFinite(line) && line > 0 ? line : 1;

      const msg = attrs.get('msg') ?? '';
      const cwe = attrs.get('cwe');
      const verbose = attrs.get('verbose') ?? msg;
      out.push({
        ruleId: `tool.cppcheck.${id}`,
        file: relativeTo(ctx.mountPath, file),
        lineStart,
        lineEnd: lineStart,
        severity: mapped.severity,
        title: `${id}: ${msg}`.slice(0, 120),
        message: cwe ? `${verbose} (CWE-${cwe})` : verbose,
        dimension: mapped.dimension,
        nativeRule: id,
      });
    }
    return out;
  },
};
