import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAndApply } from './diff.js';
import { checkErrorHandling, guardFamily } from './guard.js';
import { hitDedupKey, verifyPatch, type FileRuleRunner, type RuleHit } from './verify.js';

// The error-handling guard (W22-09, 2026-10-30). Per language family: removing
// a handler is rejected; a moved, kept or added handler is not; an ordinary fix
// is not; adding a force-unwrap is rejected.

const check = (file: string, before: string, after: string) =>
  checkErrorHandling({ file, before, after });
const lines = (...l: string[]) => l.join('\n') + '\n';

// The live outline case: DragTarget.ts:130, bpm-ch-silent-fallback-return.
const OUTLINE_BEFORE = lines(
  'function posOf(view: EditorView, node: Node): number | null {',
  '  try {',
  '    return view.posAtDOM(node, 0);',
  '  } catch {',
  '    return null;',
  '  }',
  '}',
);
const OUTLINE_AFTER = lines(
  'function posOf(view: EditorView, node: Node): number | null {',
  '  return view.posAtDOM(node, 0);',
  '}',
);

describe('checkErrorHandling — the outline shape', () => {
  it('rejects replacing try { return view.posAtDOM(node, 0) } catch { return null } with the bare call', () => {
    const r = check('app/editor/DragTarget.ts', OUTLINE_BEFORE, OUTLINE_AFTER);
    expect(r).toMatchObject({ ok: false, code: 'removes_error_handling' });
    expect(!r.ok && r.reason).toMatch(/removes error handling \(catch\)/);
  });

  it('the same on one line', () => {
    const r = check(
      'DragTarget.ts',
      '  try { return view.posAtDOM(node, 0) } catch { return null }\n',
      '  return view.posAtDOM(node, 0)\n',
    );
    expect(r).toMatchObject({ ok: false, code: 'removes_error_handling' });
  });

  it('allows the right fix: keep the catch and the null, log inside it', () => {
    const after = OUTLINE_BEFORE.replace(
      '  } catch {\n    return null;',
      '  } catch (err) {\n    Logger.debug("editor", err);\n    return null;',
    );
    expect(check('DragTarget.ts', OUTLINE_BEFORE, after)).toEqual({ ok: true });
  });
});

describe('checkErrorHandling — TypeScript / JavaScript', () => {
  const before = lines(
    'async function load(id) {',
    '  try {',
    '    return await get(id);',
    '  } catch (e) {',
    '    return undefined;',
    '  }',
    '}',
  );

  it('rejects removing a .catch(', () => {
    expect(check('a.js', 'p.then(f).catch(() => null);\n', 'p.then(f);\n')).toMatchObject({
      ok: false,
      code: 'removes_error_handling',
    });
  });
  it('allows turning try/catch into .catch( (a handler kept in another form)', () => {
    expect(
      check(
        'a.ts',
        before,
        lines('function load(id) {', '  return get(id).catch(() => undefined);', '}'),
      ),
    ).toEqual({ ok: true });
  });
  it('allows moving a try/catch out of a loop', () => {
    const inLoop = lines('for (const x of xs) {', '  try { use(x); } catch (e) { log(e); }', '}');
    const outside = lines('try {', '  for (const x of xs) use(x);', '} catch (e) { log(e); }');
    expect(check('a.ts', inLoop, outside)).toEqual({ ok: true });
  });
  it('allows adding a handler, and an ordinary fix', () => {
    expect(check('a.ts', 'run(x);\n', 'try { run(x); } catch (e) { log(e); }\n')).toEqual({
      ok: true,
    });
    expect(check('a.js', 'return eval(cmd);\n', 'return JSON.parse(cmd);\n')).toEqual({ ok: true });
  });
  it('does not count "catch" in a string or a comment', () => {
    expect(
      check('a.ts', lines('log("we catch it"); // catch', 'run();'), lines('log("x");', 'run();')),
    ).toEqual({ ok: true });
  });
  it('rejects adding a non-null assertion in TypeScript, not in JSX text', () => {
    expect(
      check('a.ts', 'const n = map.get(k)?.name;\n', 'const n = map.get(k)!.name;\n'),
    ).toMatchObject({
      ok: false,
      code: 'adds_force_unwrap',
    });
    expect(check('a.tsx', '<p>Saved</p>\n', '<p>Saved! </p>\n')).toEqual({ ok: true });
    expect(check('a.ts', 'if (a != b) f();\n', 'if (a !== b && !c) f();\n')).toEqual({ ok: true });
  });
});

describe('checkErrorHandling — Python', () => {
  const before = lines(
    'def load(p):',
    '    try:',
    '        return read(p)',
    '    except OSError:',
    '        return None',
  );
  it('rejects removing an except', () => {
    expect(check('m.py', before, lines('def load(p):', '    return read(p)'))).toMatchObject({
      ok: false,
      code: 'removes_error_handling',
    });
  });
  it('allows narrowing a bare except, logging in it, or contextlib.suppress in its place', () => {
    const bare = before.replace('except OSError:', 'except:');
    expect(
      check('m.py', bare, before.replace('return None', 'log.warning("x")\n        return None')),
    ).toEqual({ ok: true });
    expect(
      check(
        'm.py',
        before,
        lines('def load(p):', '    with suppress(OSError):', '        return read(p)'),
      ),
    ).toEqual({ ok: true });
  });
  it('allows an ordinary fix; ignores a # comment', () => {
    expect(check('m.py', 'x = eval(s)\n', 'x = literal_eval(s)\n')).toEqual({ ok: true });
    expect(check('m.py', 'run()  # except here\n', 'run()\n')).toEqual({ ok: true });
  });
});

describe('checkErrorHandling — Go', () => {
  const before = lines('v, err := load()', 'if err != nil {', '\treturn nil, err', '}', 'use(v)');
  it('rejects removing an if err != nil', () => {
    expect(check('m.go', before, lines('v, _ := load()', 'use(v)'))).toMatchObject({
      ok: false,
      code: 'removes_error_handling',
    });
  });
  it('allows wrapping the error, or adding a check for a discarded one', () => {
    expect(
      check(
        'm.go',
        before,
        before.replace('return nil, err', 'return nil, fmt.Errorf("load: %w", err)'),
      ),
    ).toEqual({ ok: true });
    expect(
      check(
        'm.go',
        '_ = f.Close()\n',
        lines('if cerr := f.Close(); cerr != nil {', '\tlog.Print(cerr)', '}'),
      ),
    ).toEqual({ ok: true });
  });
  it('rejects adding a panic', () => {
    expect(check('m.go', before, before.replace('return nil, err', 'panic(err)'))).toMatchObject({
      ok: false,
      code: 'adds_force_unwrap',
    });
  });
});

describe('checkErrorHandling — Rust', () => {
  it('rejects ? turned into .unwrap() (handling removed) and .expect( added alone', () => {
    expect(check('lib.rs', 'let v = parse(s)?;\n', 'let v = parse(s).unwrap();\n')).toMatchObject({
      ok: false,
      code: 'removes_error_handling',
    });
    expect(
      check(
        'lib.rs',
        'let v = parse(s).unwrap_or(0);\n',
        'let v = parse(s).unwrap_or(0);\nlet w = g().expect("w");\n',
      ),
    ).toMatchObject({
      ok: false,
      code: 'adds_force_unwrap',
    });
  });
  it('rejects dropping an Err arm', () => {
    const before = lines(
      'match write(buf) {',
      '    Ok(n) => n,',
      '    Err(e) => return Err(e.into()),',
      '}',
    );
    expect(check('lib.rs', before, 'let _ = write(buf);\n')).toMatchObject({
      ok: false,
      code: 'removes_error_handling',
    });
  });
  it('allows .unwrap() turned into ?, an Err match turned into ?, and an ordinary fix', () => {
    expect(check('lib.rs', 'let v = parse(s).unwrap();\n', 'let v = parse(s)?;\n')).toEqual({
      ok: true,
    });
    expect(
      check(
        'lib.rs',
        lines('let v = match parse(s) {', '    Ok(v) => v,', '    Err(e) => return Err(e),', '};'),
        'let v = parse(s)?;\n',
      ),
    ).toEqual({ ok: true });
    expect(
      check(
        'lib.rs',
        "fn f<'a>(s: &'a str) -> char { 'x' }\n",
        "fn f<'a>(s: &'a str) -> char { 'y' }\n",
      ),
    ).toEqual({ ok: true });
  });
  it('does not count ? inside a format string', () => {
    expect(check('lib.rs', 'println!("{:?}", v);\n', 'log::debug!("{v:?}");\n')).toEqual({
      ok: true,
    });
  });
});

describe('checkErrorHandling — Java / Kotlin', () => {
  const java = lines(
    'try {',
    '  return Files.readString(p);',
    '} catch (IOException e) {',
    '  return "";',
    '}',
  );
  it('Java: rejects removing a catch; allows logging in it and an ordinary fix', () => {
    expect(check('A.java', java, 'return Files.readString(p);\n')).toMatchObject({
      ok: false,
      code: 'removes_error_handling',
    });
    expect(
      check(
        'A.java',
        java,
        java.replace('  return "";', '  LOG.warn("read failed", e);\n  return "";'),
      ),
    ).toEqual({ ok: true });
    expect(
      check('A.java', 'stmt.execute(sql + id);\n', 'ps.setLong(1, id); ps.execute();\n'),
    ).toEqual({ ok: true });
  });
  it('Kotlin: rejects removing runCatching or a catch; rejects adding !!', () => {
    expect(
      check('A.kt', 'val v = runCatching { load() }.getOrNull()\n', 'val v = load()\n'),
    ).toMatchObject({ ok: false, code: 'removes_error_handling' });
    expect(check('A.kt', 'val n = user?.name ?: ""\n', 'val n = user!!.name\n')).toMatchObject({
      ok: false,
      code: 'adds_force_unwrap',
    });
  });
  it('Kotlin: allows runCatching turned into try/catch with logging', () => {
    expect(
      check(
        'A.kt',
        'val v = runCatching { load() }.getOrNull()\n',
        lines(
          'val v = try { load() } catch (e: IOException) {',
          '    log.warn("load", e); null',
          '}',
        ),
      ),
    ).toEqual({ ok: true });
  });
});

describe('checkErrorHandling — Ruby', () => {
  const before = lines('def load(p)', '  File.read(p)', 'rescue Errno::ENOENT', '  nil', 'end');
  it('rejects removing a rescue (block or modifier)', () => {
    expect(check('a.rb', before, lines('def load(p)', '  File.read(p)', 'end'))).toMatchObject({
      ok: false,
      code: 'removes_error_handling',
    });
    expect(check('a.rb', 'v = parse(s) rescue nil\n', 'v = parse(s)\n')).toMatchObject({
      ok: false,
      code: 'removes_error_handling',
    });
  });
  it('allows replacing a rescue-nil modifier with a logged rescue; ignores a # comment', () => {
    expect(
      check(
        'a.rb',
        'v = parse(s) rescue nil\n',
        lines('begin', '  v = parse(s)', 'rescue ParseError => e', '  logger.warn(e)', 'end'),
      ),
    ).toEqual({ ok: true });
    expect(check('a.rb', 'run # rescue later\n', 'run\n')).toEqual({ ok: true });
  });
});

describe('checkErrorHandling — Swift', () => {
  const before = lines(
    'do {',
    '    let d = try Data(contentsOf: url)',
    '    return d',
    '} catch {',
    '    return nil',
    '}',
  );
  it('rejects removing do/catch or try?', () => {
    expect(
      check('A.swift', before, lines('let d = try Data(contentsOf: url)', 'return d')),
    ).toMatchObject({ ok: false, code: 'removes_error_handling' });
    expect(check('A.swift', 'let d = try? load()\n', 'let d = try load()\n')).toMatchObject({
      ok: false,
      code: 'removes_error_handling',
    });
  });
  it('rejects adding try!, as! or a force-unwrap', () => {
    expect(
      check(
        'A.swift',
        'let d = try? load()\nlet x = 1\n',
        'let d = try? load()\nlet x = try! other()\n',
      ),
    ).toMatchObject({ ok: false, code: 'adds_force_unwrap' });
    expect(check('A.swift', 'let v = o as? View\n', 'let v = o as! View\n')).toMatchObject({
      ok: false,
      code: 'adds_force_unwrap',
    });
    expect(check('A.swift', 'let u = URL(string: s)\n', 'let u = URL(string: s)!\n')).toMatchObject(
      { ok: false, code: 'adds_force_unwrap' },
    );
  });
  it('allows logging inside the catch, and an ordinary fix', () => {
    expect(
      check(
        'A.swift',
        before,
        before.replace('    return nil', '    logger.error("\\(error)")\n    return nil'),
      ),
    ).toEqual({ ok: true });
    expect(check('A.swift', 'if a != b { f() }\n', 'if a != b && !c { f() }\n')).toEqual({
      ok: true,
    });
  });
});

describe('checkErrorHandling — files it does not understand', () => {
  it('is not checked', () => {
    expect(guardFamily('README.md')).toBeNull();
    expect(guardFamily('Dockerfile')).toBeNull();
    expect(check('main.c', 'try {} catch {}\n', '\n')).toEqual({ ok: true });
    expect(guardFamily('x.TSX')).toBe('TypeScript');
  });
});

// The guard inside the verification: a patch the rules alone would verify is
// rejected before any rule runs.
describe('verifyPatch with the guard', () => {
  let root = '';
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rp-guard-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const FILE = 'app/editor/DragTarget.ts';
  // A stand-in for bpm-ch-silent-fallback-return: fires on `return null` in a catch.
  const hits = (source: string): RuleHit[] =>
    source.split('\n').flatMap((t, i) =>
      t.trim() === 'return null;'
        ? [
            {
              scannerKey: 'semgrep',
              ruleId: 'bpm-ch-silent-fallback-return',
              dimension: 'code_health',
              file: FILE,
              lineStart: i + 1,
              evidenceQuote: `${FILE}:${i + 1}`,
              title: 'silent fallback',
            },
          ]
        : [],
    );
  let ran = 0;
  const runner: FileRuleRunner = {
    key: 'stub',
    scannerKeys: ['semgrep'],
    async run(input) {
      ran++;
      return { status: 'succeeded', hits: hits(input.source) };
    },
  };

  it('rejects the outline patch with removes_error_handling and runs no rule', async () => {
    const diff = [
      `--- a/${FILE}`,
      `+++ b/${FILE}`,
      '@@ -1,7 +1,3 @@',
      ' function posOf(view: EditorView, node: Node): number | null {',
      '-  try {',
      '-    return view.posAtDOM(node, 0);',
      '-  } catch {',
      '-    return null;',
      '-  }',
      '+  return view.posAtDOM(node, 0);',
      ' }',
    ].join('\n');
    const applied = validateAndApply({ modelText: diff, file: FILE, source: OUTLINE_BEFORE });
    expect(applied.after).toBe(OUTLINE_AFTER);
    const target = {
      dedupKey: hitDedupKey(hits(OUTLINE_BEFORE)[0]!),
      scannerKey: 'semgrep',
      ruleId: 'bpm-ch-silent-fallback-return',
      file: FILE,
    };
    ran = 0;
    const r = await verifyPatch({
      target,
      before: OUTLINE_BEFORE,
      after: applied.after,
      runners: [runner],
      root,
    });
    expect(r).toMatchObject({ status: 'rejected', code: 'removes_error_handling', runs: [] });
    expect(ran).toBe(0);

    // Without the removal the same rules decide as before.
    const kept = OUTLINE_BEFORE.replace(
      '    return null;',
      '    Logger.debug(err);\n    return -1;',
    ).replace('} catch {', '} catch (err) {');
    const ok = await verifyPatch({
      target,
      before: OUTLINE_BEFORE,
      after: kept,
      runners: [runner],
      root,
    });
    expect(ok).toMatchObject({ status: 'verified', code: 'verified' });
  });
});
