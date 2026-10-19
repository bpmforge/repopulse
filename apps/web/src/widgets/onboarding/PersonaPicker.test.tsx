import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { PersonaPicker } from './PersonaPicker.js';

const navigateSpy = vi.fn();
vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigateSpy,
}));

// W16-26. The picker was mandatory and it intercepted the one action a first
// run sends you to: the welcome state says "Connect your organization to start
// ingesting history", and clicking that button raised this dialog instead.
//
// At that moment there are no repositories, no PRs and no findings, so every
// option describes a screen that will be empty — "My PRs, my review queue, code
// I own" for an account with none.

const ME_NO_PERSONA = { persona: null, role: 'admin', workspace: { id: 1, slug: 'a', name: 'A' } };

function stubFetch(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

function renderPicker() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <PersonaPicker />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // "Not now" is remembered for the SESSION, so it has to be cleared between
  // tests or the second one renders nothing and passes for the wrong reason.
  window.sessionStorage.clear();
  navigateSpy.mockReset();
  stubFetch(ME_NO_PERSONA);
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('PersonaPicker (W16-26)', () => {
  it('offers a way past itself', async () => {
    renderPicker();
    expect(await screen.findByTestId('persona-picker')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('persona-defer'));

    await waitFor(() => expect(screen.queryByTestId('persona-picker')).toBeNull());
  });

  it('chooses nothing when deferred, so the choice is postponed and not lost', async () => {
    renderPicker();
    await screen.findByTestId('persona-picker');

    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await userEvent.click(screen.getByTestId('persona-defer'));

    // No PATCH: `me.persona` stays null, so the dialog returns next visit
    // rather than a persona being silently chosen for someone.
    await waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before),
    );
  });

  it('stays deferred across a reload, so it does not reappear mid-setup', async () => {
    // Component state alone was not enough: "not now" has to survive the
    // navigation it was pressed to get on with. Someone who defers and then
    // follows the connect link was asked again on the next screen, and a
    // dialog that comes back after you dismissed it reads as broken.
    renderPicker();
    await userEvent.click(await screen.findByTestId('persona-defer'));
    await waitFor(() => expect(screen.queryByTestId('persona-picker')).toBeNull());

    // A fresh mount is what a reload looks like to this component.
    renderPicker();
    await waitFor(() => expect(screen.queryByTestId('persona-picker')).toBeNull());
    // Session-scoped, not persisted: a NEW session asks again, because the
    // choice is still worth making and `me.persona` is still null.
    window.sessionStorage.clear();
    renderPicker();
    expect(await screen.findByTestId('persona-picker')).toBeInTheDocument();
  });

  it('stays out of the way once a persona has been chosen', async () => {
    stubFetch({ ...ME_NO_PERSONA, persona: 'lead' });
    renderPicker();

    await waitFor(() => expect(screen.queryByTestId('persona-picker')).toBeNull());
  });

  // W20-15 (UX_TODO X-25). The dialog opens over every route, so a colleague
  // who followed a shared link lost it the moment they picked a persona.
  it('stays on a deep-linked page when a persona is picked there', async () => {
    window.history.replaceState(null, '', '/findings?finding=812');
    stubFetch({ ...ME_NO_PERSONA, home: '/me' });
    renderPicker();
    await userEvent.click(await screen.findByTestId('persona-security'));
    await waitFor(() =>
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
        ),
      ).toBe(true),
    );
    // Give the mutation's onSuccess a chance to run.
    await new Promise((r) => setTimeout(r, 20));
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('goes to the persona home when picked from the landing page', async () => {
    stubFetch({ ...ME_NO_PERSONA, home: '/me' });
    renderPicker();
    await userEvent.click(await screen.findByTestId('persona-developer'));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: '/me' }));
  });

  it('words the defer button for anyone, not just the admin doing setup', async () => {
    renderPicker();
    expect(await screen.findByTestId('persona-defer')).toHaveTextContent(/^Not now$/);
  });
});
