import { describe, expect, it } from 'vitest';
import { stateOf } from './index.js';

// Security posture states (W8-10, NFR-15).

describe('a scanner state is never a bare zero', () => {
  it('separates switched-off, never-run and ran-clean', () => {
    // The three answers a security screen must never collapse. "0 findings"
    // for a scanner nobody enabled tells someone they are safe when nobody
    // has looked.
    expect(stateOf(false, undefined)).toBe('not_enabled');
    expect(stateOf(true, undefined)).toBe('never_run');
    expect(stateOf(true, { status: 'succeeded', partial: false })).toBe('ok');
  });

  it('a switched-off scanner reads as off even when it has old runs', () => {
    // Disabling a scanner does not delete its history, and showing the old
    // green would claim current coverage the repo no longer has.
    expect(stateOf(false, { status: 'succeeded', partial: false })).toBe('not_enabled');
  });

  it('a failed run is an ERROR, not an absence of findings', () => {
    expect(stateOf(true, { status: 'failed', partial: false })).toBe('error');
  });

  it('a budget-cut or partial run is PARTIAL, not ok', () => {
    // Findings from a cut-short scan are real but the set is incomplete, and
    // an unflagged partial scan reads as a clean one — the most dangerous
    // thing a security screen can say.
    expect(stateOf(true, { status: 'budget_exceeded', partial: true })).toBe('partial');
    expect(stateOf(true, { status: 'succeeded', partial: true })).toBe('partial');
  });

  it('a run that scanned NOTHING is not a run that found nothing (W16-31)', () => {
    // W16-28 made a zero-work sweep record a row so the table stopped saying
    // "has never run". Rendered as "ran clean" that put the lie back the other
    // way round: a green tick asserting a measurement for work that did not
    // happen, with an explanation underneath arguing with the label above it.
    //
    // The shape is a SUCCEEDED run that still has something to say, and the
    // only writer of it is scan-processor's zero-work path.
    expect(
      stateOf(true, {
        status: 'succeeded',
        partial: false,
        error: 'No commits in range to sweep — nothing was scanned.',
      }),
    ).toBe('nothing_scanned');
    expect(
      stateOf(true, {
        status: 'succeeded',
        partial: false,
        error: 'No forge connection for this repository, so there were no patches to read.',
      }),
    ).toBe('nothing_scanned');
  });

  it('a real clean run stays ok — the error field is what separates them', () => {
    expect(stateOf(true, { status: 'succeeded', partial: false, error: null })).toBe('ok');
    // A FAILED run says failed even with a message, so the new branch cannot
    // swallow a fault by being checked too early.
    expect(stateOf(true, { status: 'failed', partial: false, error: 'boom' })).toBe('error');
    // ...and a cut-short one stays partial, which is the more serious reading.
    expect(stateOf(true, { status: 'succeeded', partial: true, error: 'capped' })).toBe('partial');
  });

  it('a scan still RUNNING is not "ran clean" (W16-38)', () => {
    // scan_runs is inserted with status 'running' and updated when it
    // finishes, so between those moments this fell through to 'ok': the
    // coverage table said "✓ ran clean" about a scan that had not finished,
    // with last_run_at pointing at the moment it STARTED. A checklist takes
    // minutes, so the window is not theoretical — it is how the screen looked
    // for the whole of every OWASP run.
    expect(stateOf(true, { status: 'running', partial: false })).toBe('running');
    expect(stateOf(true, { status: 'queued', partial: false })).toBe('running');
  });

  it('a running scan does not borrow another state, whatever else is set', () => {
    // Checked FIRST, so a stale funnel or error from an earlier attempt on the
    // same row cannot make an in-flight scan describe a result it has not got.
    expect(
      stateOf(true, {
        status: 'running',
        partial: true,
        error: 'something older',
        validationFunnel: { proposed: 4, rejected: 4, created: 0 },
      }),
    ).toBe('running');
    // And a disabled scanner still reads as disabled.
    expect(stateOf(false, { status: 'running', partial: false })).toBe('not_enabled');
  });

  it('a run that never reported back is STALE, not still running (W16-39)', () => {
    // 'running' is only ever cleared by the worker that owns the row, so a
    // worker that dies mid-scan leaves it set for ever. Observed twice while
    // proving the streaming fix: the process disappeared during a long model
    // call and the table went on saying "running now" indefinitely.
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(stateOf(true, { status: 'running', partial: false, startedAt: old })).toBe('stale');
  });

  it('a slow scan that is genuinely alive is NOT called stale', () => {
    // The mirror of the bug: a checklist against a slow local model really does
    // take many minutes — one measured here ran past ten — and declaring a live
    // scan dead would be the same wrong claim in the other direction.
    const recent = new Date(Date.now() - 12 * 60 * 1000);
    expect(stateOf(true, { status: 'running', partial: false, startedAt: recent })).toBe('running');
    // And with no timestamp at all, it is not presumed dead.
    expect(stateOf(true, { status: 'running', partial: false })).toBe('running');
  });

  it('a run whose findings were ALL rejected is not "ran clean" (W16-38)', () => {
    // The model looked, proposed findings, and the evidence validator threw
    // every one out for not quoting the diff verbatim. findingCount is 0 and
    // the row used to read exactly like a run that found nothing — which is
    // the only signal anyone would get that a prompt or the check is wrong.
    expect(
      stateOf(true, {
        status: 'succeeded',
        partial: false,
        validationFunnel: { chunks: 2, proposed: 4, rejected: 4, created: 0 },
      }),
    ).toBe('all_rejected');
  });

  it('a run that kept SOME findings is ok, whatever else was rejected', () => {
    expect(
      stateOf(true, {
        status: 'succeeded',
        partial: false,
        validationFunnel: { chunks: 2, proposed: 4, rejected: 3, created: 1 },
      }),
    ).toBe('ok');
  });

  it('a run that proposed nothing is ok, not "all rejected"', () => {
    // Nothing proposed is a clean diff, and calling that "every finding was
    // rejected" would invent a problem — the mirror of the bug above.
    expect(
      stateOf(true, {
        status: 'succeeded',
        partial: false,
        validationFunnel: { chunks: 2, proposed: 0, rejected: 0, created: 0 },
      }),
    ).toBe('ok');
    // And a scanner with no funnel at all is untouched by this.
    expect(stateOf(true, { status: 'succeeded', partial: false })).toBe('ok');
  });

  it('a FAILED run stays failed even with a funnel full of rejections', () => {
    expect(
      stateOf(true, {
        status: 'failed',
        partial: false,
        error: 'boom',
        validationFunnel: { proposed: 4, rejected: 4, created: 0 },
      }),
    ).toBe('error');
  });

  it('treats an unknown partial flag as not partial, not as unknown', () => {
    // partial is nullable in the schema for rows written before it existed;
    // null means "nothing said it was cut short", which is the honest reading.
    expect(stateOf(true, { status: 'succeeded', partial: null })).toBe('ok');
  });
});
