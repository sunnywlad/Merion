import { formatAmount, type Grouping } from '@/components/ui/formatAmount';

type AmountLineProps = {
  label: string;
  isLoading: boolean;
  error: Error | null | undefined;
  value: bigint | undefined;
  /** On-chain decimals (how `value` is encoded). Defaults to 8. */
  tokenDecimals?: number;
  /** Display precision (fraction digits shown). Truncated, not rounded. Defaults to 4. */
  displayDecimals?: number;
  /** Grouping style. Default 'none'. Use 'fr' for MRN amounts. */
  grouping?: Grouping;
  /**
   * Unit shown after the value. Note d'inspiration §4 :
   *   - `wBTC`, `MRN`, `h` : rendu en `<span>` séparé, Code Small Neutral,
   *     avec espace insécable (NARROW NO-BREAK SPACE) devant — l'unité NE
   *     fait PAS partie de la colonne de chiffres alignée.
   *   - `%` : rendu en ligne dans le bloc mono, collé sans espace, parce
   *     que la note §4 distingue `%` intra-mono (`39,61%`) du `%` hors
   *     mono (rail Small : `39,61 %`).
   */
  unit?: string;
};

/**
 * Merion amount line — note d'inspiration §4.
 *
 * `font-variant-numeric: tabular-nums` aligns the digit column (rail
 * balances, reserves, percentages). The unit lives outside that column
 * for everything except `%`, which the spec ties to the mono block.
 *
 * The four states are evaluated in order: while loading, `value` is
 * undefined too, and the third branch would steal the display from the
 * first. Per brand book §2, numeric values carry no semantic colour by
 * default; Success is reserved for healthy *statuses*, not for "a number
 * that exists".
 */
export default function AmountLine({
  label,
  isLoading,
  error,
  value,
  tokenDecimals = 8,
  displayDecimals = 4,
  grouping = 'none',
  unit,
}: AmountLineProps) {
  let content: string;
  let contentClass: string;
  if (isLoading) {
    content = 'Loading…';
    contentClass = 'text-cloud/60';
  } else if (error) {
    content = error.message;
    contentClass = 'text-danger';
  } else if (value === undefined) {
    content = '—';
    contentClass = 'text-cloud/60';
  } else {
    content = formatAmount(value, {
      displayDecimals,
      tokenDecimals,
      grouping,
    });
    contentClass = 'text-cloud';
  }

  // Per §4, `%` stays glued inside the mono block; every other unit gets
  // its own span preceded by a narrow no-break space so the digit column
  // stays vertically aligned.
  const inlineUnit = unit === '%';

  return (
    <li className="flex items-baseline justify-between gap-4 py-1 text-body">
      <span className="text-cloud/80">{label}</span>
      <span className="flex items-baseline min-w-0">
        <span
          className={`font-mono text-code num-tabular ${contentClass}`}
        >
          {content}
          {inlineUnit ? unit : ''}
        </span>
        {!inlineUnit && unit ? (
          <span className="font-mono text-code-sm text-neutral">
            {' '}
            {unit}
          </span>
        ) : null}
      </span>
    </li>
  );
}
