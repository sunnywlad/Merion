import type { ReactNode } from 'react';

type DeltaDirection = 'up' | 'down' | 'flat';

type KpiCardProps = {
  label: ReactNode;
  value: ReactNode;
  /** Pourcentage formaté. Positif en Success, négatif en Danger, 0 en Neutral. */
  delta?: { value: number; suffix?: string };
  /** Mention de la période, rendue en `text-caption` sous la valeur. */
  period?: ReactNode;
  /** Micro-graphique optionnel, tracé en SVG inline. Aucun ajout de dépendance. */
  sparkline?: number[];
  className?: string;
};

function directionOf(value: number): DeltaDirection {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
}

const DELTA_COLOR: Record<DeltaDirection, string> = {
  up: 'text-success',
  down: 'text-danger',
  flat: 'text-neutral',
};

const DELTA_ARROW: Record<DeltaDirection, string> = {
  up: '↑',
  down: '↓',
  flat: '→',
};

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 100;
  const h = 28;
  const step = w / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / span) * h;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const positive = values[values.length - 1] >= values[0];
  const stroke = positive ? 'var(--color-success)' : 'var(--color-danger)';
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      role="img"
      aria-label="Trend sparkline"
      preserveAspectRatio="none"
      className="mt-3"
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

/**
 * Merion KPI card — planche 06 du brand book. Fond Slate, valeur en grand,
 * delta coloré, mention de la période, micro-graphique optionnel.
 */
export function KpiCard({
  label,
  value,
  delta,
  period,
  sparkline,
  className = '',
}: KpiCardProps) {
  return (
    <div
      className={
        `flex flex-col rounded-lg bg-slate p-4 text-cloud ${className}`
      }
    >
      <div className="text-caption uppercase tracking-wide text-cloud/70">
        {label}
      </div>
      <div className="mt-1 text-h4 font-medium">{value}</div>
      {delta ? (
        <div
          className={`mt-1 text-small font-medium ${DELTA_COLOR[directionOf(delta.value)]}`}
        >
          <span aria-hidden="true" className="mr-1">
            {DELTA_ARROW[directionOf(delta.value)]}
          </span>
          {`${delta.value > 0 ? '+' : ''}${delta.value}${delta.suffix ?? '%'}`}
        </div>
      ) : null}
      {period ? (
        <div className="mt-1 text-caption text-cloud/60">{period}</div>
      ) : null}
      {sparkline ? <Sparkline values={sparkline} /> : null}
    </div>
  );
}

export default KpiCard;
