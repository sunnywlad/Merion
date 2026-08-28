type ReservesBarProps = {
  // Token label shown on the left of the bar (e.g. "wBTC").
  tokenSymbol: string;
  // Current share of the pool, 0..1 (e.g. 0.334 for 33.4%).
  share: number;
  // Acceptable corridor around the 33% target. Out of this band, the fill
  // colour flips to Warning. Defaults to ±4 pp around 1/3, a corridor wide
  // enough that small swap imbalances stay nominal but obvious drifts trip
  // the signal — chosen against the brand book's `Dynamisme 5/10`, where
  // we want quiet but unambiguous signalling.
  bound?: { low: number; high: number };
  className?: string;
};

const DEFAULT_BOUND = { low: 1 / 3 - 0.04, high: 1 / 3 + 0.04 };
const TARGET_FRACTION = 1 / 3;

/**
 * Merion reserves bar — single horizontal bar with the token share, the
 * 33% target mark, and a colour-coded fill.
 *
 * Pure CSS rendering (no SVG, no canvas). Width transitions 300 ms, in the
 * lower half of the 300–500 ms window the brand book tolerance allows.
 * Colour transition piggybacks on the same duration.
 *
 * Accessibility: `role="meter"` with `aria-valuenow / valuemin / valuemax`
 * so screen readers can announce the share; the target tick is decorative
 * (`aria-hidden`).
 */
export function ReservesBar({
  tokenSymbol,
  share,
  bound = DEFAULT_BOUND,
  className = '',
}: ReservesBarProps) {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  // `share === 0` covers two cases: genuinely zero reserves (an empty pool)
  // and `reserves` not yet loaded. Both render with a neutral fill so we
  // never trip Warning on missing data.
  const noData = share === 0;
  const outOfBounds =
    !noData && (share < bound.low || share > bound.high);
  const fillClass = noData
    ? 'bg-neutral'
    : outOfBounds
      ? 'bg-warning'
      : 'bg-merion-blue';

  return (
    <div className={`flex flex-col gap-1 min-w-0 ${className}`}>
      <div className="flex items-baseline justify-between gap-2 text-small">
        <span className="text-cloud/80">{tokenSymbol}</span>
        <span className="font-mono text-code text-cloud">
          {pct.toFixed(2)}%
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${tokenSymbol} pool share`}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-2 rounded bg-slate overflow-hidden"
      >
        <div
          className={`absolute inset-y-0 left-0 transition-all duration-300 ease-out ${fillClass}`}
          style={{ width: `${pct}%` }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-y-0 w-0.5 bg-cloud/60"
          style={{ left: `${TARGET_FRACTION * 100}%` }}
        />
      </div>
    </div>
  );
}

export default ReservesBar;