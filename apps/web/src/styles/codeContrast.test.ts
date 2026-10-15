import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// WCAG contrast for the code and diff tokens (W18-30). The tint tokens carry
// alpha, so each one is composited over the surface it really sits on, the same
// way contrast.test.ts handles badge tints. Reads the real theme.css.

const candidates = [
  path.resolve(process.cwd(), 'src/styles/theme.css'),
  path.resolve(process.cwd(), 'apps/web/src/styles/theme.css'),
];
const file = candidates.find((c) => existsSync(c));
if (!file) throw new Error(`theme.css not found; looked in: ${candidates.join(', ')}`);
const CSS = readFileSync(file, 'utf8');

type Rgba = { r: number; g: number; b: number; a: number };

function parseColour(v: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (hex) {
    const h = hex[1]!;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const m = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(v.trim());
  if (!m) throw new Error(`cannot parse colour: ${v}`);
  return { r: +m[1]!, g: +m[2]!, b: +m[3]!, a: m[4] === undefined ? 1 : +m[4] };
}

function block(theme: 'dark' | 'light'): Record<string, Rgba> {
  const start =
    theme === 'dark'
      ? CSS.indexOf('--code-bg: #0c1018')
      : CSS.indexOf("--code-bg: #f6f8fa");
  if (start < 0) throw new Error('code tokens missing from theme.css');
  const end = CSS.indexOf('\n}', start);
  const out: Record<string, Rgba> = {};
  for (const m of CSS.slice(start, end).matchAll(/--((?:code|tok)-[a-z-]+):\s*([^;]+);/g)) {
    out[m[1]!] = parseColour(m[2]!);
  }
  return out;
}

function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

function lum({ r, g, b }: Rgba): number {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SYNTAX = [
  'tok-keyword',
  'tok-string',
  'tok-number',
  'tok-func',
  'tok-type',
  'tok-comment',
  'tok-punct',
] as const;

describe.each(['dark', 'light'] as const)('%s code tokens (WCAG 2.2 AA)', (theme) => {
  const t = block(theme);
  const bg = t['code-bg']!;
  const surfaces: Record<string, Rgba> = {
    code: bg,
    add: over(t['code-add-bg']!, bg),
    del: over(t['code-del-bg']!, bg),
    range: over(t['code-range-bg']!, bg),
  };

  it('parses every token it asserts on', () => {
    for (const k of [...SYNTAX, 'code-fg', 'code-gutter', 'code-gutter-bg', 'code-hunk-fg']) {
      expect(t[k], k).toBeDefined();
    }
  });

  it.each(SYNTAX)('%s clears 4.5:1 on code, added, removed and ranged rows', (k) => {
    for (const [name, s] of Object.entries(surfaces)) {
      expect(ratio(t[k]!, s), `${k} on ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('plain code text clears 4.5:1 on every row kind', () => {
    for (const [name, s] of Object.entries(surfaces)) {
      expect(ratio(t['code-fg']!, s), `code-fg on ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('line numbers clear 4.5:1 on the gutter (grey on plain rows, full text colour on tinted rows)', () => {
    expect(ratio(t['code-gutter']!, t['code-gutter-bg']!)).toBeGreaterThanOrEqual(4.5);
    expect(
      ratio(t['code-fg']!, over(t['code-add-gutter']!, surfaces['add']!)),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      ratio(t['code-fg']!, over(t['code-del-gutter']!, surfaces['del']!)),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('the +/- marks clear 4.5:1 on their rows', () => {
    expect(ratio(t['code-add-mark']!, surfaces['add']!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t['code-del-mark']!, surfaces['del']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('the hunk header clears 4.5:1 on its tint', () => {
    expect(ratio(t['code-hunk-fg']!, over(t['code-hunk-bg']!, bg))).toBeGreaterThanOrEqual(4.5);
  });
});
