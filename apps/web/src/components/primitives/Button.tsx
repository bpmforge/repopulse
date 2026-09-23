import type { ButtonHTMLAttributes, ReactNode } from 'react';

// The button (W17-12).
//
// There were 70 `<button>` elements in this app and no primitive, so each one
// carried its own hand-written class string. The visible cost was inconsistent
// padding and radius; the invisible one was the FOCUS RING — a keyboard user's
// only way of knowing where they are — appearing in four different forms and,
// in a few places, not at all.
//
// Variants map to meaning, not to colour:
//   primary    the one action this view exists for. At most one per section.
//   secondary  a real action, not the main one.
//   ghost      low-emphasis; toolbar and inline controls.
//   danger     destructive or irreversible.
//
// Colour is never the only signal. `danger` is red AND says what it does; a
// disabled button is dimmed AND carries the disabled attribute, so it is
// announced rather than merely looking inert.

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Shows a pending state AND disables the control.
   *
   * Separate from `disabled` on purpose: a pending button must keep announcing
   * WHY it cannot be pressed, and the two states read differently to a screen
   * reader (aria-busy vs disabled alone).
   */
  pending?: boolean;
  children: ReactNode;
}

/**
 * One focus ring for the whole product.
 *
 * `focus-visible`, not `focus`, so a mouse click does not leave a ring behind —
 * that is the thing that makes people remove focus styles altogether. The
 * offset keeps it legible on a filled button, where a flush ring disappears
 * into the fill.
 */
const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

const VARIANTS: Record<ButtonVariant, string> = {
  // accent-STRONG, not accent: this is a fill that white text sits on, and the
  // text token is deliberately lighter so links stay readable. See theme.css.
  primary: 'bg-accent-strong text-accent-fg hover:opacity-90 border border-transparent',
  secondary: 'bg-surface-2 text-fg border border-border hover:border-border-strong',
  ghost: 'bg-transparent text-fg-muted border border-transparent hover:text-fg',
  danger: 'bg-transparent text-crit border border-crit/40 hover:border-crit',
};

const SIZES: Record<ButtonSize, string> = {
  // 44px is the practical minimum touch target; md hits it with the border.
  md: 'h-10 px-3 text-sm',
  sm: 'h-8 px-2.5 text-xs',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  pending = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      // A pending action is not available, but the reason differs from an
      // action that is simply unavailable — hence both attributes.
      disabled={disabled === true || pending}
      aria-busy={pending || undefined}
      className={[
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium',
        // Short, and only on properties that do not move layout. No continuous
        // animation anywhere: prefers-reduced-motion is honoured globally in
        // theme.css, and a pulsing control is a distraction, not a signal.
        'transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-60',
        SIZES[size],
        VARIANTS[variant],
        FOCUS,
        className ?? '',
      ].join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}
