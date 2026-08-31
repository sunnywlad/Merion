import type { ReactNode } from 'react';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

type StatusDotProps = {
  tone: StatusTone;
  label?: ReactNode;
  className?: string;
};

const TONE_BG: Record<StatusTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-neutral',
};

/**
 * Merion status dot. Pastille pleine, 12 px, cinq tons.
 *
 * `label` est exposé en sr-only quand fourni, pour nommer la pastille sans
 * perturber la composition visuelle.
 */
export function StatusDot({ tone, label, className = '' }: StatusDotProps) {
  const hasLabel = label !== undefined;
  const stringLabel = typeof label === 'string' ? label : undefined;

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span
        aria-hidden={hasLabel ? undefined : 'true'}
        aria-label={stringLabel}
        className={`inline-block h-3 w-3 rounded-full ${TONE_BG[tone]}`}
      />
      {hasLabel ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

export default StatusDot;
