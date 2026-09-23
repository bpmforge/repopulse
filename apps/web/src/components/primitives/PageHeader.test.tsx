import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.js';
import { PageHeader, SectionHeader } from './PageHeader.js';

// W17-12. What is worth asserting here is the accessibility contract, not the
// class strings — a snapshot of Tailwind classes fails on every restyle and
// proves nothing about whether the thing is usable.

describe('PageHeader (W17-12)', () => {
  it('renders the page title as the document h1', () => {
    // One h1 per screen: it is what a screen-reader user lands on, and the
    // shell renders no other.
    render(<PageHeader title="Repositories" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Repositories' })).toBeInTheDocument();
  });

  it('renders description, meta and actions when given', () => {
    render(
      <PageHeader
        title="Overview"
        description="What needs attention this week."
        meta={<span data-testid="window-chip">30d</span>}
        actions={<Button>Refresh</Button>}
      />,
    );
    expect(screen.getByText('What needs attention this week.')).toBeInTheDocument();
    expect(screen.getByTestId('window-chip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('omits the optional parts entirely rather than rendering empty boxes', () => {
    const { container } = render(<PageHeader title="Bare" />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('uses a type scale that distinguishes page from section', () => {
    // The defect this replaces: /admin used text-lg (18px) for its PAGE title,
    // the same size as a section title elsewhere, so the two levels were
    // indistinguishable.
    const { container: page } = render(<PageHeader title="P" />);
    const { container: section } = render(<SectionHeader title="S" />);
    expect(page.querySelector('h1')?.className).toContain('text-3xl');
    expect(section.querySelector('h2')?.className).toContain('text-lg');
  });
});

describe('SectionHeader (W17-12)', () => {
  it('defaults to h2, directly under the page h1', () => {
    render(<SectionHeader title="Top actions" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Top actions' })).toBeInTheDocument();
  });

  it('can be h3 where the outline genuinely nests', () => {
    // Skipping a level breaks the outline a screen reader navigates by, so the
    // level is a choice the caller makes rather than a styling accident.
    render(<SectionHeader title="Sub" as="h3" />);
    expect(screen.getByRole('heading', { level: 3, name: 'Sub' })).toBeInTheDocument();
  });
});

describe('Button (W17-12)', () => {
  it('is a real button element, so keyboard and screen readers get it free', () => {
    render(<Button>Run scan</Button>);
    const btn = screen.getByRole('button', { name: 'Run scan' });
    btn.focus();
    expect(document.activeElement).toBe(btn);
  });

  it('defaults to type="button", so it cannot submit a form by accident', () => {
    render(<Button>Safe</Button>);
    expect(screen.getByRole('button', { name: 'Safe' })).toHaveAttribute('type', 'button');
  });

  it('carries ONE focus-visible ring, not a focus ring on mouse click', () => {
    // focus (not focus-visible) is what makes designers delete focus styles.
    render(<Button>Focus</Button>);
    const cls = screen.getByRole('button', { name: 'Focus' }).className;
    expect(cls).toContain('focus-visible:outline');
    expect(cls).not.toMatch(/(^|\s)focus:outline/);
  });

  it('a pending button is disabled AND announced as busy', () => {
    // Two attributes because they mean different things: busy says why.
    render(<Button pending>Saving</Button>);
    const btn = screen.getByRole('button', { name: 'Saving' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });

  it('a pending button does not fire its handler', async () => {
    const onClick = vi.fn();
    render(
      <Button pending onClick={onClick}>
        Saving
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Saving' })).catch(() => {});
    expect(onClick).not.toHaveBeenCalled();
  });

  it('a normal button does fire', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('every variant renders and keeps the accessible name', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger'] as const) {
      const { unmount } = render(<Button variant={variant}>{variant}</Button>);
      expect(screen.getByRole('button', { name: variant })).toBeInTheDocument();
      unmount();
    }
  });

  it('never animates continuously', () => {
    // A pulsing control is a distraction, not a signal, and it fights
    // prefers-reduced-motion.
    render(<Button>Still</Button>);
    const cls = screen.getByRole('button', { name: 'Still' }).className;
    expect(cls).not.toContain('animate-pulse');
    expect(cls).not.toContain('animate-ping');
  });

  it('meets the practical touch-target height at default size', () => {
    render(<Button>Tap</Button>);
    expect(screen.getByRole('button', { name: 'Tap' }).className).toContain('h-10');
  });
});
