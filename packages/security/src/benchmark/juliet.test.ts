import { describe, expect, it } from 'vitest';
import {
  blankLiterals,
  isTestcasePath,
  julietLabels,
  methodRanges,
  stride,
} from './prepare-juliet.js';

// The Juliet label derivation (W18-40): labels come from the code's own naming,
// so the derivation is what decides every number the suite publishes.

const SINGLE = `package testcases.CWE89_SQL_Injection.s01;

public class CWE89_SQL_Injection__Property_executeQuery_01 extends AbstractTestCase
{
    /* uses bad source and bad sink */
    public void bad() throws Throwable
    {
        String data = System.getProperty("user.home"); // a } in a comment
        String sql = "SELECT * FROM t WHERE n = '" + data + "}'";
        stmt.executeQuery(sql);
    }

    public void good() throws Throwable
    {
        goodG2B();
        goodB2G();
    }

    /* goodG2B() - use goodsource and badsink */
    private void goodG2B() throws Throwable
    {
        String data = "foo";
        stmt.executeQuery("SELECT * FROM t WHERE n = '" + data + "'");
    }

    private void goodB2G() throws Throwable
    {
        stmt.executeQuery("SELECT 1");
    }
}
`;

describe('Juliet label derivation', () => {
  it('blanks comments and literals but keeps line breaks and length', () => {
    const out = blankLiterals('a // x }\n"}" /* }\n */ b');
    expect(out.length).toBe('a // x }\n"}" /* }\n */ b'.length);
    expect(out.split('\n').length).toBe(3);
    expect(out).not.toContain('}');
  });

  it('finds bad and good* methods with the right inclusive lines, and skips good()', () => {
    const ranges = methodRanges(SINGLE);
    expect(ranges.map((r) => r.name)).toEqual(['bad', 'goodG2B', 'goodB2G']);
    expect(ranges[0]!.lines).toEqual([6, 11]);
    expect(ranges[1]!.lines).toEqual([20, 24]);
    expect(ranges[2]!.lines).toEqual([26, 29]);
  });

  it('labels bad() a defect and each good*() a near-miss, all with the CWE', () => {
    const labels = julietLabels(
      'CWE89_SQL_Injection/s01/CWE89_SQL_Injection__Property_executeQuery_01.java',
      SINGLE,
      89,
      'testcases',
    );
    expect(labels.map((l) => [l.id.split('#')[1], l.expect])).toEqual([
      ['bad', 'finding'],
      ['goodG2B', 'none'],
      ['goodB2G', 'none'],
    ]);
    expect(new Set(labels.map((l) => l.cwe))).toEqual(new Set([89]));
    expect(labels[0]!.lines).toEqual([6, 11]);
  });

  it('labels the multi-file helper classes as whole files and ignores the base class', () => {
    const f = (name: string) =>
      julietLabels(`CWE78_OS_Command_Injection/s01/${name}`, 'class X {}', 78, 'testcases');
    expect(f('CWE78_OS_Command_Injection__Property_81_bad.java')).toMatchObject([
      { expect: 'finding' },
    ]);
    expect(f('CWE78_OS_Command_Injection__Property_81_goodG2B.java')).toMatchObject([
      { expect: 'none' },
    ]);
    expect(f('CWE78_OS_Command_Injection__Property_81_base.java')).toEqual([]);
    expect(f('CWE78_OS_Command_Injection__Property_81_bad.java')[0]!.lines).toBeUndefined();
  });

  it('gives each label a unique id within a file', () => {
    const labels = julietLabels('d/f_01.java', SINGLE, 89, 'testcases');
    expect(new Set(labels.map((l) => l.id)).size).toBe(labels.length);
  });
});

describe('stride sampling', () => {
  it('returns everything when there are few, and an even spread when there are many', () => {
    expect(stride([1, 2, 3], 5)).toEqual([1, 2, 3]);
    const picked = stride(
      Array.from({ length: 100 }, (_, i) => i),
      10,
    );
    expect(picked).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });
});

describe('test case selection', () => {
  it('keeps the test cases and drops the ant build scaffolding next to them', () => {
    expect(
      isTestcasePath('CWE89_SQL_Injection/s01/CWE89_SQL_Injection__Property_executeQuery_01.java'),
    ).toBe(true);
    expect(
      isTestcasePath(
        'CWE259_Hard_Coded_Password/antbuild/testcases/CWE259_Hard_Coded_Password/Main.java',
      ),
    ).toBe(false);
    expect(
      isTestcasePath(
        'CWE327_Use_Broken_Crypto/antbuild/testcases/CWE327_Use_Broken_Crypto/ServletMain.java',
      ),
    ).toBe(false);
    // Only a path SEGMENT named antbuild counts, not a name that contains it.
    expect(isTestcasePath('CWE89_SQL_Injection/s01/Antbuilder_01.java')).toBe(true);
  });
});
