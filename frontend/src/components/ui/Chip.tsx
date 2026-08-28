'use client';

import { type ReactNode } from 'react';

type ChipProps = {
  children: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  className?: string;
};

/**
 * Merion chip — planche 06 du brand book. Pilule avec libellé et croix de
 * retrait. Si `onRemove` est absent, la croix n'est pas rendue.
 */
export function Chip({
  children,
  onRemove,
  removeLabel = 'Remove',
  className = '',
}: ChipProps) {
  return (
    <span
      className={
        `inline-flex items-center gap-2 rounded-full border border-cloud/30 ` +
        `bg-slate px-3 py-1 text-small text-cloud ${className}`
      }
    >
      <span>{children}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className={
            'inline-flex h-5 w-5 items-center justify-center rounded-full ' +
            'text-cloud/70 hover:bg-cloud/10 hover:text-cloud ' +
            'focus:outline-none focus-visible:border-merion-blue ' +
            'focus-visible:border-2 focus-visible:border-solid'
          }
        >
          <span aria-hidden="true" className="leading-none">
            ×
          </span>
        </button>
      ) : null}
    </span>
  );
}

export default Chip;
