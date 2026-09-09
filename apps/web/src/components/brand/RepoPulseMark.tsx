// The RepoPulse mark (W17-13).
//
// Two commit nodes joined by one line that carries a single pulse kink. That is
// the whole product in one shape: a repository's history, and its health read
// off it.
//
// DESIGNED FOR 16px FIRST, which is where it spends most of its life — a
// browser tab. Everything that reads well at 32px and dissolves at 16 was cut:
// no fork (two strokes converging blur into one), no text inside the mark, no
// gradient, no third node. What survives at 16px is two dots and a heartbeat,
// and that is legible.
//
// currentColor throughout, so it inherits from wherever it is placed and works
// monochrome — a favicon, a dark rail, a light sign-in card, and a printed
// report all get the right thing with no variants to maintain.

export interface RepoPulseMarkProps {
  /** Rendered size in px. 16 / 24 / 32 are the tested sizes. */
  size?: number;
  /**
   * An accessible name, when this mark is the ONLY content of a link or button.
   *
   * Omitted means decorative — the mark is then aria-hidden, which is correct
   * whenever a visible "RepoPulse" wordmark sits beside it. Announcing the logo
   * twice is noise.
   */
  title?: string;
  className?: string;
}

export function RepoPulseMark({
  size = 24,
  title,
  className,
}: RepoPulseMarkProps): React.JSX.Element {
  const decorative = title === undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={title}
      // focusable="false" because IE/Edge legacy put SVGs in the tab order;
      // harmless elsewhere and cheap insurance for a decorative element.
      focusable="false"
    >
      {/* The two commits. Filled, so they hold their shape at 16px where a
          2px-stroked ring closes up into a blob anyway. */}
      <circle cx="4.5" cy="12" r="2.25" fill="currentColor" />
      <circle cx="19.5" cy="12" r="2.25" fill="currentColor" />
      {/* The history between them, with one beat. Round caps and joins so the
          kink reads as a pulse rather than as a glitch.
          The amplitude was raised after looking at it: the first version spanned
          y 7.5..16.5, using only the middle third of a square, so as a favicon it
          rendered as a small squiggle in a lot of empty tab. This spans
          y 4.5..19.5 and reads as a heartbeat at 16px. */}
      <path
        d="M7 12 H9.5 L11.5 5.5 L14 18.5 L16 12 H17.25"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface RepoPulseWordmarkProps {
  /** Hide the text and show the mark alone — the collapsed rail. */
  markOnly?: boolean;
  size?: number;
  className?: string;
}

/**
 * Mark plus the RepoPulse wordmark.
 *
 * The mark is aria-hidden here because the word beside it already names the
 * product; a screen reader should hear "RepoPulse" once.
 */
export function RepoPulseWordmark({
  markOnly = false,
  size = 24,
  className,
}: RepoPulseWordmarkProps): React.JSX.Element {
  return (
    <span className={`inline-flex items-center gap-2 text-fg ${className ?? ''}`}>
      {markOnly ? (
        // Alone, so it has to carry the name itself.
        <RepoPulseMark size={size} title="RepoPulse" />
      ) : (
        <>
          <RepoPulseMark size={size} />
          <span className="font-semibold tracking-tight">RepoPulse</span>
        </>
      )}
    </span>
  );
}
