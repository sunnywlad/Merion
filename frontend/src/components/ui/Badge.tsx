import { type ReactNode } from 'react';

export type BadgeVariant = 'new' | 'active' | 'beta' | 'deprecated' | 'neutral';

type BadgeProps = {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
};

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  new: 'border-merion-blue text-merion-blue',
  active: 'border-success text-success',
  beta: 'border-warning text-warning',
  deprecated: 'border-neutral text-neutral',
  neutral: 'border-cloud text-cloud',
};

/**
 * Merion badge — pilule contournée, cinq variantes.
 *
 * Variantes : New, Active, Beta, Deprecated.
 * `neutral` est un fallback pour les usages non encore listés.
 */
export function Badge({
  variant = 'neutral',
  children,
  className = '',
}: BadgeProps) {
  return (
    <span
      className={
        `inline-flex items-center rounded-full border px-2 py-0.5 ` +
        `text-caption font-medium uppercase tracking-wide ` +
        `${VARIANT_CLASS[variant]} ${className}`
      }
    >
      {children}
    </span>
  );
}

export default Badge;
