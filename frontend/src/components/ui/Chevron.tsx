import type { CSSProperties } from 'react';

type ChevronProps = {
  /** When true, the chevron is rotated 180° (expanded). */
  open?: boolean;
  /** ARIA label override (defaults to "Toggle details"). */
  label?: string;
  className?: string;
};

/**
 * Merion chevron — note d'inspiration §8.
 *
 * 12 px Neutral glyph (`▾`), 200 ms rotation transition on `transform`
 * only (note §9: `transform` and `box-shadow` are exempt from transition
 * rules but the rotation itself stays under 200 ms ease-in-out for
 * consistency with `merion-retractable`). The `prefers-reduced-motion`
 * killswitch in `globals.css` zeroes the transition globally.
 */
export function Chevron({
  open = false,
  label = 'Toggle details',
  className = '',
}: ChevronProps) {
  // Static style is fine: rotation is purely transform-driven, no
  // layout shift, and the data-open attribute keeps the visual state
  // accessible to screen readers via the surrounding aria-expanded.
  const style: CSSProperties = {};
  return (
    <span
      role="img"
      aria-label={label}
      data-open={open ? 'true' : 'false'}
      className={`merion-chevron ${className}`}
      style={style}
    >
      ▾
    </span>
  );
}

export default Chevron;
