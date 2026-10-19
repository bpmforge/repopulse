import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CiTokenExpiryNotice,
  expiringTokens,
  expiryState,
  expiryWords,
  type ExpiringTokenInput,
} from './CiTokenExpiry.js';

// W20-15 (UX_TODO X-19). On the day a CI token expires every pipeline using it
// fails with exit code 3, and nothing in RepoPulse said so beforehand.

const useApiQuery = vi.hoisted(() => vi.fn());
vi.mock('../../api/useApiQuery.js', () => ({ useApiQuery }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const token = (id: number, inDays: number, over: Partial<ExpiringTokenInput> = {}) => ({
  id,
  name: `token ${id}`,
  expires_at: new Date(NOW + inDays * DAY).toISOString(),
  revoked_at: null,
  ...over,
});

describe('CI token expiry (W20-15, UX_TODO X-19)', () => {
  it('flags tokens that expire within 14 days, and expired ones nobody revoked', () => {
    expect(expiryState(token(1, 3), NOW)).toBe('expiring');
    expect(expiryState(token(1, 14), NOW)).toBe('expiring');
    expect(expiryState(token(1, 15), NOW)).toBeNull();
    expect(expiryState(token(1, -2), NOW)).toBe('expired');
    expect(expiryState(token(1, -2, { revoked_at: '2026-10-01T00:00:00.000Z' }), NOW)).toBeNull();
  });

  it('lists the due ones soonest first', () => {
    const due = expiringTokens([token(1, 10), token(2, 90), token(3, 2)], NOW);
    expect(due.map((t) => t.id)).toEqual([3, 1]);
  });

  it('says when, in words', () => {
    expect(expiryWords(token(1, 3).expires_at!, NOW)).toBe('expires in 3 days');
    expect(expiryWords(token(1, 1).expires_at!, NOW)).toBe('expires tomorrow');
    expect(expiryWords(token(1, -2).expires_at!, NOW)).toBe('expired 2 days ago');
  });

  it('warns on System health and Setup, and is silent when nothing is due', () => {
    const soon = token(5, 3, { expires_at: new Date(Date.now() + 3 * DAY).toISOString() });
    useApiQuery.mockReturnValue({ data: { items: [soon] } });
    const { unmount } = render(<CiTokenExpiryNotice />);
    expect(screen.getByTestId('ci-token-expiry')).toHaveTextContent(/A CI token needs replacing/);
    expect(screen.getByTestId('ci-token-expiry-5')).toHaveTextContent(
      'token 5 — expires in 3 days',
    );
    unmount();

    useApiQuery.mockReturnValue({
      data: {
        items: [token(6, 0, { expires_at: new Date(Date.now() + 200 * DAY).toISOString() })],
      },
    });
    render(<CiTokenExpiryNotice />);
    expect(screen.queryByTestId('ci-token-expiry')).toBeNull();
  });
});
