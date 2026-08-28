'use client';

import { type ButtonHTMLAttributes, type ReactNode } from 'react';

type ButtonLevel = 'primary' | 'secondary' | 'tertiary';

type ButtonProps = {
  level?: ButtonLevel;
  showArrow?: boolean;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

/**
 * Merion button — planche 06 du brand book, trois niveaux, quatre états.
 *
 * États : default / hover / active / disabled.
 * La flèche `→` apparaît en fin de libellé, sauf pour le Tertiaire qui n'a pas
 * de libellé d'action. Le contrôleur passe `showArrow` pour la forcer.
 *
 * Focus visible : bordure Merion Blue de 2 px (cf. brand book §7).
 */
export function Button({
  level = 'primary',
  showArrow,
  type = 'button',
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  const arrow = showArrow ?? level !== 'tertiary';

  const base =
    'inline-flex items-center justify-center gap-2 rounded font-medium ' +
    'transition-colors duration-150 ' +
    'focus:outline-none focus-visible:border-merion-blue focus-visible:border-2 ' +
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none';

  const size = 'px-4 py-2 text-body';

  const levelClass =
    level === 'primary'
      ? 'bg-merion-blue text-white border-2 border-merion-blue ' +
        'hover:bg-merion-blue/90 hover:border-merion-blue/90 ' +
        'active:bg-merion-blue/80 active:border-merion-blue/80'
      : level === 'secondary'
        ? 'bg-transparent text-cloud border-2 border-cloud ' +
          'hover:bg-cloud/10 ' +
          'active:bg-cloud/20'
        : 'bg-transparent text-cloud border-2 border-transparent ' +
          'px-1 py-1 ' +
          'hover:text-cloud ' +
          'active:underline active:underline-offset-4';

  return (
    <button
      type={type}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      className={`${base} ${size} ${levelClass} ${className}`.trim()}
      {...rest}
    >
      <span>{children}</span>
      {arrow ? (
        <span aria-hidden="true" className="leading-none">
          →
        </span>
      ) : null}
    </button>
  );
}

export default Button;
