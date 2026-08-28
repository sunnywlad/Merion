import type { ReactNode } from 'react';

type RetractableProps = {
  /** When true, the panel is expanded. Controlled by the parent. */
  open: boolean;
  /** Element id, used by the toggle button's `aria-controls`. */
  id: string;
  children: ReactNode;
  className?: string;
};

/**
 * Merion retractable block — note d'inspiration §8 + §9.
 *
 * Renders its children inside a CSS grid row that transitions between
 * `grid-template-rows: 0fr` and `1fr` (200 ms ease-in-out). No
 * `max-height` trickery, no JS measurement. The transition is killed
 * to 0 ms under `prefers-reduced-motion` (see `globals.css`).
 *
 * This is a presentational wrapper only: it does NOT manage open
 * state. Callers own the state and pass `open` down.
 */
export function Retractable({
  open,
  id,
  children,
  className = '',
}: RetractableProps) {
  return (
    <div
      id={id}
      data-open={open ? 'true' : 'false'}
      className={`merion-retractable ${className}`}
      aria-hidden={!open}
    >
      <div className="merion-retractable-inner">{children}</div>
    </div>
  );
}

export default Retractable;
