import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingDetail } from './FindingDetail.js';
import { SecretRotated } from './FindingProof.js';
import type { Finding } from './contracts.js';
import { validateFindingsSearch } from '../../routes/findings/index.js';
import {
  hasPullFailure,
  sandboxPartOf,
  looksLikeMissingScanTools,
} from '../security/ScannerStatusList.js';
import { pickerPaths } from '../repo/AiPassPanel.js';
import { lastCallText, ModelChoices } from '../admin/LlmProviders.js';

// W20-21: review dates (FND-25), rotated secrets (FND-61), the PR link and
// last-seen scan (FND-70, FND-51), link filters in the URL (FND-22/55/68,
// AI-32), image pull failures kept apart from missing tools (FND-62), the
// pass pickers (AI-31) and the model list after Test (AI-20, AI-63).

type Opts = { onSuccess?: () => void };
const calls = vi.hoisted<{ list: { endpoint: string; body: unknown }[] }>(() => ({ list: [] }));
const me = vi.hoisted<{ role: string }>(() => ({ role: 'member' }));
vi.mock('../../api/useApiQuery.js', () => ({
  useApiMutation: (d: { endpoint: string }) => ({
    mutate: (body: unknown, _opts?: Opts) => calls.list.push({ endpoint: d.endpoint, body }),
    isPending: false,
    isSuccess: false,
    variables: undefined,
    error: null,
  }),
  useApiQuery: (d: { endpoint: string }) =>
    d.endpoint === '/me/context' ? { data: { role: me.role } } : { data: { items: [] } },
  queryKeyFor: (d: { endpoint: string }) => [d.endpoint],
}));

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 7,
    repo: { id: 1, org: 'acme', name: 'payments' },
    dimension: 'security',
    severity: 3,
    confidence: 4,
    title: 'SQL from input',
    file: 'src/db.ts',
    line_range: [3, 3],
    evidence: 'q = "select " + x',
    recommendation: 'Use a parameter.',
    status: 'open',
    dismiss_reason: null,
    occurrence_count: 1,
    verify_status: 'unverified',
    first_seen_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-08-02T00:00:00.000Z',
    tier: 1,
    forge: null,
    scanner_key: 'semgrep',
    ...over,
  } as Finding;
}

beforeEach(() => {
  calls.list = [];
  me.role = 'member';
});

describe('finding panel (FND-25, FND-51, FND-70, FND-47)', () => {
  it('asks for a review date before an accepted risk can be dismissed, and sends it', () => {
    render(<FindingDetail finding={finding()} onClose={() => {}} invalidate={[]} />);
    fireEvent.change(screen.getByTestId('finding-note'), {
      target: { value: 'the team accepts this one' },
    });
    fireEvent.change(screen.getByTestId('finding-dismiss-reason'), {
      target: { value: 'accepted_risk' },
    });
    const dismiss = screen.getByTestId('finding-dismiss');
    expect(dismiss).toBeDisabled();
    fireEvent.change(screen.getByTestId('finding-review-by'), { target: { value: '2027-01-31' } });
    expect(dismiss).not.toBeDisabled();
    fireEvent.click(dismiss);
    expect(calls.list.at(-1)).toMatchObject({
      endpoint: '/findings/{id}',
      body: { status: 'dismissed', dismiss_reason: 'accepted_risk', review_by: '2027-01-31' },
    });
  });

  it('links the pull request, names the last scan and says how hand-off works', () => {
    render(
      <FindingDetail
        finding={finding({
          pull_request: { number: 42 },
          last_seen_scan: { id: 3, commit_sha: 'abc1234def', at: '2026-08-02T00:00:00Z' },
        })}
        onClose={() => {}}
        invalidate={[]}
      />,
    );
    expect(screen.getByTestId('finding-pr-link')).toHaveAttribute('href', '/repos/1/prs/42');
    expect(screen.getByTestId('finding-meta-last-seen')).toHaveTextContent('abc1234');
    expect(screen.getByTestId('finding-handoff-note')).toHaveTextContent(/ticket/);
    expect(screen.queryByTestId('finding-rescan')).toBeNull();
  });

  it('offers admins a re-scan of the scanner that raised it', () => {
    me.role = 'admin';
    render(<FindingDetail finding={finding()} onClose={() => {}} invalidate={[]} />);
    fireEvent.click(screen.getByTestId('finding-rescan'));
    expect(calls.list.at(-1)).toEqual({
      endpoint: '/repos/{id}/scan',
      body: { scanner_key: 'semgrep' },
    });
  });
});

describe('rotated secrets (FND-61)', () => {
  it('says removing the line does not close it, and records a rotation with a note', () => {
    render(<SecretRotated finding={finding({ dimension: 'secrets' })} invalidate={[]} />);
    expect(screen.getByTestId('secret-rotated')).toHaveTextContent(/does not close/);
    fireEvent.click(screen.getByTestId('secret-rotated-open'));
    const submit = screen.getByTestId('secret-rotated-submit');
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId('secret-rotated-note'), {
      target: { value: 'revoked at the issuer' },
    });
    fireEvent.click(submit);
    expect(calls.list.at(-1)).toMatchObject({
      endpoint: '/findings/{id}/rotated',
      body: { note: 'revoked at the issuer' },
    });
  });

  it('says a rotated secret stays closed', () => {
    render(
      <SecretRotated
        finding={finding({ status: 'resolved', dismiss_reason: 'rotated' })}
        invalidate={[]}
      />,
    );
    expect(screen.getByTestId('secret-rotated-done')).toBeInTheDocument();
  });
});

describe('link filters in the URL', () => {
  it('keeps digit lists and the known values, and drops the rest', () => {
    expect(
      validateFindingsSearch({
        ids: '1,2,3',
        scan_run_id: '9',
        closed_by_scan_run: 9,
        ai_pass_run_id: '4',
        found_by: 'model',
        dimension_group: 'security',
        severity: '5',
      }),
    ).toEqual({
      ids: '1,2,3',
      scan_run_id: '9',
      closed_by_scan_run: '9',
      ai_pass_run_id: '4',
      found_by: 'model',
      dimension_group: 'security',
      severity: 5,
    });
    expect(
      validateFindingsSearch({
        ids: '1;drop',
        found_by: 'person',
        severity: '9',
        dimension_group: 'x',
      }),
    ).toEqual({});
  });
});

describe('image pull failures are not missing tools (FND-62)', () => {
  const error =
    'Could not pull ghcr.io/acme/private:1: manifest unknown; Not scanned (over the 10-image limit per run): a:1';
  it('reads only the sandbox part for the tools advice', () => {
    expect(looksLikeMissingScanTools(error)).toBe(true);
    expect(looksLikeMissingScanTools(sandboxPartOf(error))).toBe(false);
    expect(hasPullFailure(error)).toBe(true);
    expect(sandboxPartOf('spawn podman ENOENT')).toBe('spawn podman ENOENT');
  });
});

describe('pass pickers (AI-31)', () => {
  it('offers every file and the directories above it', () => {
    expect(pickerPaths(['src/a/x.ts', 'src/b.ts'])).toEqual([
      'src',
      'src/a',
      'src/a/x.ts',
      'src/b.ts',
    ]);
  });
});

describe('models (AI-20, AI-63)', () => {
  it('offers the server list and warns when the typed name is not in it', () => {
    const picked: string[] = [];
    render(
      <ModelChoices
        models={['qwen3-coder', 'llama-3']}
        current="qwen3"
        onPick={(m) => picked.push(m)}
        testId="mc"
      />,
    );
    expect(screen.getByTestId('mc-unknown')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('mc-select'), { target: { value: 'llama-3' } });
    expect(picked).toEqual(['llama-3']);
  });

  it('says whether a connection is answering', () => {
    expect(lastCallText({})).toBe('no call yet');
    expect(
      lastCallText({
        last_success_at: '2026-10-20T10:00:00Z',
        last_error_at: '2026-10-21T10:00:00Z',
      }),
    ).toMatch(/^failing since/);
    expect(lastCallText({ last_success_at: '2026-10-21T10:00:00Z' })).toMatch(/^answered/);
  });
});
