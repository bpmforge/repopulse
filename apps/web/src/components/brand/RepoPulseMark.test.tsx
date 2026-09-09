import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RepoPulseMark, RepoPulseWordmark } from './RepoPulseMark.js';

// W17-13. The mark's job is to be recognisable at 16px and to say the product's
// name exactly once — so the tests are about geometry that survives and about
// the accessibility tree, not about how it looks.

describe('RepoPulseMark (W17-13)', () => {
  it('is aria-hidden when decorative — a wordmark beside it already names it', () => {
    const { container } = render(<RepoPulseMark />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role', 'img');
  });

  it('carries an accessible name when it stands alone', () => {
    render(<RepoPulseMark title="RepoPulse" />);
    const img = screen.getByRole('img', { name: 'RepoPulse' });
    expect(img).toBeInTheDocument();
    expect(img).not.toHaveAttribute('aria-hidden');
  });

  it('renders at each tested size without changing its viewBox', () => {
    // The viewBox is what makes it scale; a size that changed it would clip.
    for (const size of [16, 24, 32]) {
      const { container, unmount } = render(<RepoPulseMark size={size} />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('width', String(size));
      expect(svg).toHaveAttribute('height', String(size));
      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
      unmount();
    }
  });

  it('draws entirely inside the viewBox, so nothing clips at any size', () => {
    // Checked as numbers rather than by eye: the nodes are r=2.25 at cx 4.5 and
    // 19.5, so they span x 2.25..21.75, and the pulse spans y 5.5..18.5 before a
    // 2px stroke widens it to 4.5..19.5. All inside 0..24.
    const { container } = render(<RepoPulseMark />);
    const circles = [...container.querySelectorAll('circle')];
    expect(circles).toHaveLength(2);
    for (const c of circles) {
      const cx = Number(c.getAttribute('cx'));
      const cy = Number(c.getAttribute('cy'));
      const r = Number(c.getAttribute('r'));
      expect(cx - r).toBeGreaterThanOrEqual(0);
      expect(cx + r).toBeLessThanOrEqual(24);
      expect(cy - r).toBeGreaterThanOrEqual(0);
      expect(cy + r).toBeLessThanOrEqual(24);
    }

    const d = container.querySelector('path')?.getAttribute('d') ?? '';
    const coords = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    const stroke = Number(container.querySelector('path')?.getAttribute('strokeWidth') ?? 2);
    for (const n of coords) {
      expect(n - stroke / 2).toBeGreaterThanOrEqual(0);
      expect(n + stroke / 2).toBeLessThanOrEqual(24);
    }
  });

  it('uses currentColor only, so it works monochrome and inherits its context', () => {
    // A hardcoded hue would need a variant per theme and would be wrong on a
    // printed report.
    const { container } = render(<RepoPulseMark />);
    const html = container.innerHTML;
    expect(html).toContain('currentColor');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(html).not.toContain('linearGradient');
  });

  it('contains no text — glyphs inside a 16px mark are unreadable', () => {
    const { container } = render(<RepoPulseMark size={16} />);
    expect(container.querySelector('text')).toBeNull();
  });

  it('never animates', () => {
    // A continuously pulsing logo is a distraction and fights reduced motion.
    const { container } = render(<RepoPulseMark />);
    expect(container.querySelector('animate')).toBeNull();
    expect(container.querySelector('animateTransform')).toBeNull();
    expect(container.innerHTML).not.toContain('animate-');
  });
});

describe('RepoPulseWordmark (W17-13)', () => {
  it('announces the product name exactly once when mark and word are together', () => {
    const { container } = render(<RepoPulseWordmark />);
    // The mark is decorative here; the visible word carries the name.
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('RepoPulse')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('mark-only still carries the name, for the collapsed rail', () => {
    // Collapsed, the rail used to show no brand at all — a column of icons with
    // nothing saying which application this is.
    render(<RepoPulseWordmark markOnly />);
    expect(screen.getByRole('img', { name: 'RepoPulse' })).toBeInTheDocument();
    expect(screen.queryByText('RepoPulse')).toBeNull();
  });
});

describe('the favicon matches the component (W17-13)', async () => {
  // Two copies of the same geometry exist on purpose — a favicon is fetched
  // before any JS runs, so it cannot be rendered from the component. This is
  // the gate that keeps them the same shape.
  const { readFileSync, existsSync } = await import('node:fs');
  const path = await import('node:path');

  const faviconPath = [
    path.resolve(process.cwd(), 'public/favicon.svg'),
    path.resolve(process.cwd(), 'apps/web/public/favicon.svg'),
  ].find((p) => existsSync(p));

  it('exists where index.html says it does', () => {
    expect(faviconPath, 'apps/web/public/favicon.svg is missing').toBeTruthy();
  });

  it('draws the same path as the component', () => {
    const svg = readFileSync(faviconPath as string, 'utf8');
    const { container } = render(<RepoPulseMark />);
    const componentPath = container.querySelector('path')?.getAttribute('d');

    expect(componentPath).toBeTruthy();
    expect(svg.replace(/\s+/g, ' ')).toContain(componentPath as string);
    // And both commit nodes.
    expect(svg).toContain('cx="4.5"');
    expect(svg).toContain('cx="19.5"');
  });
});
