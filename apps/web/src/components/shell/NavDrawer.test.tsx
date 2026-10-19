import { createElement, createRef, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NavDrawer } from './NavDrawer.js';
import { navGroups } from './Rail.js';

// W17-14. This drawer is hand-rolled because the app has no dialog primitive
// installed and adding a dependency needs a TECH_STACK amendment. That makes
// these tests the ONLY thing standing between a keyboard user and a modal they
// cannot escape — so the four dialog behaviours are tested explicitly.

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    onClick,
    ...rest
  }: {
    children: ReactNode;
    to: string;
    onClick?: () => void;
  } & Record<string, unknown>) => createElement('a', { href: to, onClick, ...rest }, children),
  useRouterState: () => '/',
}));

function renderDrawer(overrides: Partial<Parameters<typeof NavDrawer>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(<NavDrawer open onClose={onClose} {...overrides} />);
  return { onClose, ...utils };
}

describe('NavDrawer (W17-14)', () => {
  it('is a modal dialog with an accessible name', () => {
    renderDrawer();
    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('renders nothing at all when closed', () => {
    render(<NavDrawer open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('LABELS every destination — the icon rail it replaces did not', () => {
    // The measured defect: nine unlabelled icons on a 390px screen, with only a
    // `title` attribute that a touch device never shows.
    renderDrawer();
    for (const group of navGroups(true)) {
      for (const item of group.items) {
        expect(screen.getByText(item.label)).toBeInTheDocument();
      }
    }
  });

  it('keeps the Workspace group reachable rather than dropping it', () => {
    renderDrawer();
    for (const label of ['My Focus', 'Pull Requests', 'Saved Views']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('hides Settings from a non-admin, and offers their own Account page instead', () => {
    render(<NavDrawer open onClose={vi.fn()} isAdmin={false} />);
    expect(screen.queryByText('Settings')).toBeNull();
    // W20-04 (UX_TODO ADM-04): the slot a member clicked to meet an admin wall
    // now leads somewhere they may go.
    expect(screen.getByText('Account')).toBeInTheDocument();
    // …while everything a member may use is still there.
    expect(screen.getByText('Overview')).toBeInTheDocument();
  });

  it('ESCAPE closes it', async () => {
    const { onClose } = renderDrawer();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('returns focus to the trigger on close, not to the body', async () => {
    // Dropping focus on <body> puts a keyboard user back at the top of the
    // document with no idea where they are.
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = trigger;

    render(<NavDrawer open onClose={vi.fn()} returnFocusTo={ref} />);
    await userEvent.click(screen.getByTestId('nav-drawer-close'));

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('moves focus INTO the drawer when it opens', () => {
    renderDrawer();
    // Otherwise a keyboard user has to tab through the whole page to reach it.
    expect(screen.getByTestId('nav-drawer')).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it('TRAPS Tab inside the panel', async () => {
    renderDrawer();
    const panel = screen.getByTestId('nav-drawer');
    const focusables = [...panel.querySelectorAll<HTMLElement>('a[href], button')];
    const last = focusables[focusables.length - 1] as HTMLElement;

    last.focus();
    await userEvent.tab();

    // Wrapped to the first control rather than escaping into the page behind.
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(focusables[0]);
  });

  it('wraps backwards too', async () => {
    renderDrawer();
    const panel = screen.getByTestId('nav-drawer');
    const focusables = [...panel.querySelectorAll<HTMLElement>('a[href], button')];
    (focusables[0] as HTMLElement).focus();

    await userEvent.tab({ shift: true });

    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
  });

  it('closes after choosing a destination', async () => {
    // Leaving it open over the screen the user just asked for is the commonest
    // drawer bug.
    const { onClose } = renderDrawer();
    await userEvent.click(screen.getByTestId('drawer-repos'));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on a click outside', async () => {
    const { onClose } = renderDrawer();
    await userEvent.click(screen.getByTestId('nav-drawer-scrim'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders a badge count, and nothing at all for zero', () => {
    render(<NavDrawer open onClose={vi.fn()} badges={{ '/pull-requests': 4, '/repos': 0 }} />);
    expect(screen.getByTestId('drawer-pull-requests')).toHaveTextContent('4');
    expect(screen.getByTestId('drawer-repos')).not.toHaveTextContent('0');
  });
});

describe('nav grouping (W17-14)', () => {
  it('keeps every pre-existing destination — renames are presentation only', () => {
    // The URLs are the contract. A rename that moved one would break every
    // bookmark and every deep link in every report already sent.
    const all = navGroups(true).flatMap((g) => g.items.map((i) => i.to));
    expect(all.sort()).toEqual(
      [
        '/',
        '/admin',
        '/findings',
        '/me',
        '/plans',
        '/pull-requests',
        '/repos',
        '/reports',
        '/views',
      ].sort(),
    );
  });

  it('presents six primary destinations, not nine', () => {
    expect(navGroups(true)[0]?.items).toHaveLength(6);
  });

  it('groups the three personal surfaces under Workspace', () => {
    const secondary = navGroups(true)[1];
    expect(secondary?.label).toBe('Workspace');
    expect(secondary?.items.map((i) => i.to)).toEqual(['/me', '/pull-requests', '/views']);
  });

  it('renames Findings to Reviews and Admin to Settings without moving them', () => {
    const byPath = new Map(
      navGroups(true)
        .flatMap((g) => g.items)
        .map((i) => [i.to, i.label]),
    );
    expect(byPath.get('/findings')).toBe('Reviews');
    expect(byPath.get('/admin')).toBe('Settings');
  });
});

describe('NavDrawer sign out (W20-01, UX_TODO ADM-02)', () => {
  it('offers Sign out on the phone, where there is no user menu', () => {
    renderDrawer();
    expect(screen.getByTestId('nav-drawer-signout').textContent).toMatch(/Sign out/);
  });
});
