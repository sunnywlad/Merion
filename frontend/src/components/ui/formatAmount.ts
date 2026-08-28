import { formatUnits } from 'viem';

/**
 * Display-side number formatters for Merion, per the inspiration note §4.
 *
 * Rules:
 *   - BTC wrapped (wBTC, cbBTC, LBTC) — 4 decimals, truncated, no grouping.
 *   - MRN — 2 decimals, French grouping ("90 004 980,00"), truncated.
 *   - Percentages (pool share, fees) — 2 decimals, suffixed with `%`.
 *
 * `value` is the on-chain bigint; we read the on-chain `tokenDecimals`
 * (e.g. 8 for wBTC mocks, 18 for MRN) and only THEN truncate to the
 * display precision. Truncation is deliberate: rounding up would let a
 * displayed balance exceed the real one.
 */

export type Grouping = 'fr' | 'none';

export type FormatAmountOptions = {
  /** Number of fractional digits to display. Truncated, not rounded. */
  displayDecimals: number;
  /** On-chain decimals (how `value` is encoded). */
  tokenDecimals: number;
  /** Grouping style for the displayed string. Default 'none'. */
  grouping?: Grouping;
};

/** Truncate `value` to `decimals` fractional digits without rounding. */
export function truncate(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.trunc(value * factor) / factor;
}

/**
 * Format a `value / 10^tokenDecimals` number with French grouping
 * (non-breaking thousands separator, comma decimal).
 *
 *   formatFr(1234567.89, 2) === "1 234 567,89"
 *   formatFr(-1234567.89, 2) === "-1 234 567,89"
 */
export function formatFr(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '—';
  const truncated = truncate(Math.abs(value), decimals);
  const sign = value < 0 ? '-' : '';
  const fixed = truncated.toFixed(decimals);
  const [intPart, fracPart = ''] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return fracPart.length > 0
    ? `${sign}${grouped},${fracPart}`
    : `${sign}${grouped}`;
}

/**
 * Format `raw` (a token-denominated bigint) for display.
 *
 * Returns '—' when `raw` is undefined, finite-precision `value` collapses
 * to a non-finite number (e.g. reading a malformed balance), or any of
 * the inputs is invalid. Never invents a value.
 */
export function formatAmount(
  raw: bigint | undefined,
  options: FormatAmountOptions,
): string {
  const { displayDecimals, tokenDecimals, grouping = 'none' } = options;
  if (raw === undefined) return '—';
  if (tokenDecimals < 0 || displayDecimals < 0) return '—';

  const textual = formatUnits(raw, tokenDecimals);
  const value = Number(textual);
  if (!Number.isFinite(value)) return textual;

  const truncated = truncate(value, displayDecimals);
  if (grouping === 'fr') return formatFr(truncated, displayDecimals);
  return truncated.toFixed(displayDecimals);
}
