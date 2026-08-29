/**
 * Merion swap decomposition bar — II.4 / V.4.
 *
 * Two-zone horizontal bar that contrasts the swap's CERTAIN loss
 * (fee + price impact) against its POTENTIAL loss (slippage buffer).
 * The visual treatment makes the two categories distinguishable
 * without needing to read the legend: solid merion-blue for the
 * certain zone, striped turquoise for the potential zone.
 *
 * Reads come from `quoteSwap`:
 *   - `fee` (input units, bigint)
 *   - `priceImpact` (output units, bigint — converted via `amountOut`)
 *   - `slippage` (user tolerance in percent, e.g. 0.5)
 *   - `input` (input amount, bigint)
 *
 * When no quote is available (input === 0, or any segment is
 * undefined / NaN), the bar renders a neutral empty state with the
 * « Awaiting quote » label.
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
   * `priceImpact` is converted to its input-equivalent so the two
   * zones compare on a single scale. When absent, the bar renders
   * with a direct ratio (the visual width is approximate).
   */
  amountOut?: number;
  /**
   * Suffix appended to the certain-loss value (e.g. 'wBTC'). Covers the fee
   * AND the price impact: the legend converts the impact into input units so
   * the two read as one number. There is deliberately no separate impact unit.
   */
  feeUnit?: string;
  /** Slippage label suffix (defaults to '%'). */
  slippageUnit?: string;
  className?: string;
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
  // OUTPUT token (see `quoteSwap.ts`); we convert via the spot rate
  // `input / amountOut` so all three values live on a single scale.
  // (See git history for the previous three-segment formulation.)
  const feeW = fee / input;
  const impactW = amountOut !== undefined && amountOut > 0
    ? priceImpact / amountOut
    : priceImpact / input;
  const slippageW = slippage / 100;

  // The two zones. `certain` is what the swap will definitely cost the
  // user; `potential` is the additional loss the user is accepting by
  // setting slippage tolerance. Both are fractions of input.
  const certainW = feeW + impactW;
  const potentialW = slippageW;
  const totalW = certainW + potentialW;

  // When the two zones combined exceed 100% of input, the user is
  // accepting a worst case greater than the whole trade — render the
  // bar with a warning outline so it cannot be mistaken for a normal
  // state. Both zones are then scaled to fit.
  const overDeadBand = totalW > 1;
  const scale = overDeadBand && totalW > 0 ? 1 / totalW : 1;

  // For the legend: sum the certain loss in INPUT units so the user
  // sees one number, not two in different tokens. `priceImpact` is
  // converted via the spot rate.
  const impactInInput = amountOut !== undefined && amountOut > 0
    ? priceImpact * (input / amountOut)
    : priceImpact;
  const certainInInput = fee + impactInInput;

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div
        className={`flex h-3 w-full overflow-hidden rounded ${
          overDeadBand ? 'ring-1 ring-warning' : ''
        }`}
        role="img"
        aria-label={
          `Swap decomposition: certain ${trim(certainInInput)}${feeUnit ? ' ' + feeUnit : ''}` +
          `, potential ${trim(slippage)}${slippageUnit}`
        }
      >
        {/* CERTAIN — fee + price impact, solid merion-blue */}
        <div
          className="merion-decomp-segment bg-merion-blue"
          style={{ width: `${certainW * scale * 100}%` }}
          title={`Certain: ${trim(certainInInput)}${feeUnit ? ' ' + feeUnit : ''} (fee + price impact)`}
        />
        {/* POTENTIAL — slippage buffer, striped turquoise */}
        <div
          className="merion-decomp-segment bg-turquoise/40"
          style={{
            width: `${potentialW * scale * 100}%`,
            backgroundImage:
              'repeating-linear-gradient(45deg, transparent 0 4px, rgba(45,212,191,0.55) 4px 8px)',
          }}
          title={`Potential: ${trim(slippage)}${slippageUnit} (max extra if market moves)`}
        />
        {/* Untraded remainder of the input — light fill, only when both zones fit. */}
        {!overDeadBand && certainW + potentialW < 1 ? (
          <div
            className="merion-decomp-segment bg-cloud/10"
            style={{ width: `${(1 - certainW - potentialW) * 100}%` }}
            aria-hidden="true"
          />
        ) : null}
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption">
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-merion-blue" />
          <span className="text-cloud/70">Certain</span>
          <span className="font-mono text-code-sm text-cloud">
            {trim(certainInInput)}{feeUnit ? ' ' + feeUnit : ''}
          </span>
          <span className="text-cloud/50">(fee + impact)</span>
        </li>
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-sm bg-turquoise/60"
            style={{
              backgroundImage:
                'repeating-linear-gradient(45deg, transparent 0 2px, rgba(45,212,191,0.8) 2px 3px)',
            }}
          />
          <span className="text-cloud/70">Potential</span>
          <span className="font-mono text-code-sm text-cloud">
            {trim(slippage)}{slippageUnit}
          </span>
          <span className="text-cloud/50">(max extra)</span>
        </li>
      </ul>
    </div>
  );
}

export default SwapDecompositionBar;
