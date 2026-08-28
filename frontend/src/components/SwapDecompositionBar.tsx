/**
 * Merion swap decomposition bar — II.4.
 *
 * Single horizontal bar that visualises the swap's input split into four
 * segments, in brand-book order: fee, price impact, slippage ceiling, and
 * over-dead-band (Warning). All widths are fractions of the input.
 *
 * Reads come from `quoteSwap`:
 *   - `fee` (input units, bigint)
 *   - `priceImpact` (output units, bigint — converted via `amountOut` when provided)
 *   - `slippage` (user tolerance in percent, e.g. 0.5)
 *   - `input` (input amount, bigint)
 *
 * When no quote is available (input === 0, or any segment is undefined / NaN),
 * the bar renders a neutral empty state with the « Awaiting quote » label.
 */

type SwapDecompositionBarProps = {
  /** Input amount in absolute units (input token decimals). */
  input: number;
  /** Fee taken off the input, in input units. */
  fee: number;
  /** Price impact, in OUTPUT units (see amountOut for the conversion). */
  priceImpact: number;
  /** Slippage tolerance, as a percent (0.5 means 0.5%). */
  slippage: number;
  /**
   * Optional expected output amount. When present, the output-unit
   * `priceImpact` is converted to its input-equivalent so the three
   * segments compare on a single scale. When absent, the segment renders
   * with a direct ratio (the visual width is approximate).
   */
  amountOut?: number;
  /** Suffix appended to the fee value (e.g. 'wBTC'). */
  feeUnit?: string;
  /** Suffix appended to the price-impact value (e.g. 'cbBTC'). */
  impactUnit?: string;
  /** Slippage label suffix (defaults to '%'). */
  slippageUnit?: string;
  className?: string;
};

type Segment = {
  key: string;
  width: number;
  className: string;
  label: string;
  /** Formatted value for the legend. */
  valueText: string;
  /** When true, marks the bar as having an over-dead-band segment. */
  highlight?: boolean;
};

/** Strip trailing zeros so 0.025000 reads as 0.025, 1.000000 reads as 1. */
function trim(n: number, max = 6): string {
  if (!Number.isFinite(n)) return '—';
  const fixed = n.toFixed(max);
  return fixed.replace(/\.?0+$/, '') || '0';
}

export function SwapDecompositionBar({
  input,
  fee,
  priceImpact,
  slippage,
  amountOut,
  feeUnit = '',
  impactUnit = '',
  slippageUnit = '%',
  className = '',
}: SwapDecompositionBarProps) {
  const valid =
    Number.isFinite(input) && input > 0 &&
    Number.isFinite(fee) && fee >= 0 &&
    Number.isFinite(priceImpact) && priceImpact >= 0 &&
    Number.isFinite(slippage) && slippage >= 0;

  if (!valid) {
    return (
      <div className={`flex flex-col gap-2 ${className}`} aria-label="Awaiting quote">
        <div className="h-3 w-full overflow-hidden rounded bg-cloud/10" aria-hidden="true" />
        <p className="text-caption text-cloud/60">Awaiting quote</p>
      </div>
    );
  }

  // Each loss as a fraction of input. `priceImpact` is denominated in the
  // OUTPUT token (see `quoteSwap.ts`); to render alongside the input-token
  // fee, we convert via the user's actual quote ratio: `input / amountOut`
  // is the spot proxy that turns `impactOut` into `impactIn`, then divided
  // by `input` to land in fraction-of-input space. The two cancel, leaving
  // `priceImpact / amountOut` — the proportion of OUTPUT that the curve is
  // eating, treated as a fraction of input via the trade ratio.
  const feeW = fee / input;
  const impactW = amountOut !== undefined && amountOut > 0
    ? priceImpact / amountOut
    : priceImpact / input;
  // User-typed tolerance expressed as a percent. Visualised as a fraction of
  // input (the tolerance is conceptually against the OUTPUT, but rendering it
  // as a fraction of input keeps the three segments on a comparable scale).
  const slippageW = slippage / 100;

  const lossesTotal = feeW + impactW + slippageW;
  const overDeadBandW = Math.max(0, lossesTotal - 1);
  const untouchedW = Math.max(0, 1 - lossesTotal);

  const segments: Segment[] = [
    {
      key: 'fee',
      width: feeW,
      className: 'bg-merion-blue',
      label: 'Fee',
      valueText: `${trim(fee)}${feeUnit ? ' ' + feeUnit : ''}`,
    },
    {
      key: 'impact',
      width: impactW,
      className: 'bg-merion-blue',
      label: 'Price impact',
      valueText: `${trim(priceImpact)}${impactUnit ? ' ' + impactUnit : ''}`,
    },
    {
      key: 'slippage',
      width: slippageW,
      className: 'bg-merion-blue',
      label: 'Slippage',
      valueText: `${trim(slippage)}${slippageUnit}`,
    },
  ];

  if (overDeadBandW > 0) {
    segments.push({
      key: 'over',
      width: overDeadBandW,
      className: 'bg-warning',
      label: 'Over-dead-band',
      valueText: trim(overDeadBandW * input),
      highlight: true,
    });
  }

  // Scale every segment + untouched to fit 100% of the bar when the loss
  // segments overflow. Preserves the warning segment's relative size.
  const totalForBar = segments.reduce((acc, s) => acc + s.width, 0) + untouchedW;
  const scale = totalForBar > 0 ? 1 / totalForBar : 0;

  const accessibleSummary = segments
    .map((s) => `${s.label} ${s.valueText}`)
    .join(', ');

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div
        className="flex h-3 w-full overflow-hidden rounded"
        role="img"
        aria-label={`Swap decomposition: ${accessibleSummary}`}
      >
        {segments.map((s) => (
          <div
            key={s.key}
            className={s.className}
            style={{ width: `${s.width * scale * 100}%` }}
            title={`${s.label}: ${s.valueText}`}
          />
        ))}
        {untouchedW > 0 ? (
          <div
            className="bg-cloud/10"
            style={{ width: `${untouchedW * scale * 100}%` }}
            aria-hidden="true"
          />
        ) : null}
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 rounded-full ${s.className}`}
            />
            <span className="text-cloud/70">{s.label}</span>
            <span className="font-mono text-code-sm text-cloud">{s.valueText}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default SwapDecompositionBar;
