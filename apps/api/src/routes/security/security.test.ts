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

  it('treats an unknown partial flag as not partial, not as unknown', () => {
    // partial is nullable in the schema for rows written before it existed;
    // null means "nothing said it was cut short", which is the honest reading.
    expect(stateOf(true, { status: 'succeeded', partial: null })).toBe('ok');
  });
});
