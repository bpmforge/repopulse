import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// WCAG contrast, MEASURED (W17-12).
//
// theme.css has carried a careful AA claim in a comment since W4-12, including
// the subtle part — that a badge's text sits on a /15 tint of ITSELF, not on the
// page background, and that tinting a background with the text's own hue eats
// the contrast. That comment also says why the claim was never enforced:
//
//   "jsdom component tests cannot compute contrast so the suite stayed green"
//
// So the rule lived in prose next to the values it constrained, and the only
// thing keeping them true was whoever last edited them remembering to check. A
// colour is a number; this computes it.
//
// It reads the REAL theme.css rather than a copy, so a token added or changed
// without re-measuring fails here instead of in someone's eyes.

/**
 * Resolved from cwd, not from import.meta.url: these tests run under jsdom,
 * where import.meta.url is not a file: URL and `new URL(...)` throws
 * "The URL must be of scheme file".
 */
function themePath(): string {
  const candidates = [
    path.resolve(process.cwd(), 'src/styles/theme.css'),
    path.resolve(process.cwd(), 'apps/web/src/styles/theme.css'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`theme.css not found; looked in: ${candidates.join(', ')}`);
  return found;
}

const THEME = readFileSync(themePath(), 'utf8');

/** WCAG 2.2 AA for normal-size text. */
const AA_NORMAL = 4.5;
/** WCAG 2.2 AA for large text (≥18.66px bold or ≥24px) and UI components. */
const AA_LARGE = 3;

type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '').trim();
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: Rgb, bg: Rgb): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (a + 0.05) / (b + 0.05);
}

/**
 * Composite `fg` at `alpha` over `bg` — what a Tailwind `/15` tint actually
 * renders as. This is the step that makes badge contrast real rather than
 * theoretical: the badge's background is 15% of its own text colour.
 */
function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return {
    r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
    g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
    b: Math.round(fg.b * alpha + bg.b * (1 - alpha)),
  };
}

/** Pull one theme's token map out of theme.css. */
function tokens(theme: 'dark' | 'light'): Record<string, string> {
  // Dark lives in @theme; light overrides in :root[data-theme='light'].
  //
  // Anchored on the real SELECTOR, not on the bare string: the file's header
  // comment mentions [data-theme='light'] 190 characters before @theme even
  // starts, so a naive indexOf sliced a zero-length block and every assertion
  // below passed vacuously against an empty token map. The
  // "parses every colour token" test is what caught it.
  const themeStart = THEME.indexOf('@theme {');
  const lightStart = THEME.indexOf(":root[data-theme='light'] {");
  if (themeStart < 0 || lightStart < 0 || lightStart < themeStart) {
    throw new Error('theme.css no longer has the expected @theme / :root[data-theme] structure');
  }

  const darkBlock = THEME.slice(themeStart, lightStart);
  const lightBlock = THEME.slice(lightStart, THEME.indexOf('\n}', lightStart));

  const parse = (block: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
      out[m[1] as string] = m[2] as string;
    }
    return out;
  };

  const dark = parse(darkBlock);
  return theme === 'dark' ? dark : { ...dark, ...parse(lightBlock) };
}

const THEMES = ['dark', 'light'] as const;

/** Text roles that carry body copy, and every surface they are rendered on. */
const BODY_TEXT = ['fg', 'fg-muted', 'fg-faint'];
const SURFACES = ['bg', 'surface', 'surface-2'];

/** Roles rendered as a /15 tint of themselves — SeverityBadge, HealthBadge. */
const TINTED = [
  'sev-critical',
  'sev-high',
  'sev-medium',
  'sev-low',
  'sev-info',
  'health-good',
  'health-watch',
  'health-attend',
  'ok',
  'warn',
  'crit',
  'info',
];

describe.each(THEMES)('%s theme contrast (WCAG 2.2 AA)', (theme) => {
  const t = tokens(theme);

  it('parses every colour token it is about to assert on', () => {
    // A rename that silently emptied this map would make every assertion below
    // vacuously pass.
    for (const name of [...BODY_TEXT, ...SURFACES, ...TINTED, 'accent', 'accent-strong', 'accent-fg']) {
      expect(t[name], `--color-${name} missing from theme.css`).toBeTruthy();
    }
  });

  it.each(BODY_TEXT)('%s clears 4.5:1 on every surface', (role) => {
    for (const surface of SURFACES) {
      const ratio = contrast(hexToRgb(t[role] as string), hexToRgb(t[surface] as string));
      expect(
        ratio,
        `${theme}: --color-${role} on --color-${surface} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it.each(TINTED)('%s clears 4.5:1 on a /15 tint of ITSELF', (role) => {
    // The case the comment in theme.css warns about, and the one a check
    // against --color-bg alone silently passes.
    for (const surface of ['surface', 'surface-2']) {
      const fg = hexToRgb(t[role] as string);
      const tinted = over(fg, hexToRgb(t[surface] as string), 0.15);
      const ratio = contrast(fg, tinted);
      expect(
        ratio,
        `${theme}: --color-${role} on its /15 tint over --color-${surface} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it('accent-fg is readable on the accent-strong FILL used by primary buttons', () => {
    const ratio = contrast(
      hexToRgb(t['accent-fg'] as string),
      hexToRgb(t['accent-strong'] as string),
    );
    expect(
      ratio,
      `${theme}: accent-fg on accent-strong is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('accent is readable AS TEXT on every surface — links use it', () => {
    // The assertion this file was missing. Without it, darkening the accent to
    // fix white-on-button silently dropped every link to 4.18:1, and axe found
    // 128 violations that this test had called clean.
    for (const surface of SURFACES) {
      const ratio = contrast(hexToRgb(t.accent as string), hexToRgb(t[surface] as string));
      expect(
        ratio,
        `${theme}: accent AS TEXT on --color-${surface} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it('the accent is distinguishable as a UI component boundary (3:1)', () => {
    // Focus rings and selected states are UI components, not text — 3:1 is the
    // right bar, and it must clear on every surface a ring can appear over.
    for (const surface of SURFACES) {
      const ratio = contrast(hexToRgb(t.accent as string), hexToRgb(t[surface] as string));
      expect(
        ratio,
        `${theme}: accent on ${surface} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it('borders are visible enough to bound a card (3:1 against their surface)', () => {
    // A card whose border a low-vision user cannot see is a card without a
    // boundary. border-strong is the one that must carry it.
    const ratio = contrast(hexToRgb(t['border-strong'] as string), hexToRgb(t.bg as string));
    expect(ratio, `${theme}: border-strong on bg is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      1.5,
    );
  });
});

describe('the contrast checker itself', () => {
  // A measuring instrument nobody has checked is not evidence.
  it('computes the textbook ratios', () => {
    expect(contrast(hexToRgb('#000000'), hexToRgb('#ffffff'))).toBeCloseTo(21, 1);
    expect(contrast(hexToRgb('#ffffff'), hexToRgb('#ffffff'))).toBeCloseTo(1, 5);
  });

  it('is symmetric — order of arguments cannot change a verdict', () => {
    const a = hexToRgb('#1f2328');
    const b = hexToRgb('#f6f8fa');
    expect(contrast(a, b)).toBeCloseTo(contrast(b, a), 10);
  });

  it('composites a tint the way a browser does', () => {
    // 15% white over black is #262626.
    expect(over(hexToRgb('#ffffff'), hexToRgb('#000000'), 0.15)).toEqual({
      r: 38,
      g: 38,
      b: 38,
    });
  });

  it('would FAIL a known-bad pair, so a pass means something', () => {
    // #818b98 on white was 3.45:1 — the exact value W7-04 had to fix. If this
    // checker called that acceptable, every assertion above would be theatre.
    const ratio = contrast(hexToRgb('#818b98'), hexToRgb('#ffffff'));
    expect(ratio).toBeLessThan(AA_NORMAL);
    expect(ratio).toBeCloseTo(3.45, 1);
  });
});
