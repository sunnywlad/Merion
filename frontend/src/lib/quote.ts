import { parseAmount } from "@/lib/parseAmount";

// A null quote means no transaction can be built yet. `reason` is filled only when the user
// did something wrong: an unfinished form stays silent.
export type QuoteResult<Q> =
  | {quote: Q, reason: null}
  | {quote: null, reason: string | null};

// Same discriminated shape as QuoteResult: a null tolerance always carries its reason.
export type ToleranceResult =
  | {tolerance: bigint, reason: null}
  | {tolerance: null, reason: string};

// Share of `part` in `whole`, in basis points, so `formatUnits(_, 2)` renders it as a percentage.
// A null `whole` yields 0 rather than an exception: the only way to get there is a swap of zero,
// where every figure on screen is legitimately zero anyway.
export function shareBps(part: bigint, whole: bigint): bigint {
  return whole === 0n ? 0n : part * 10000n / whole;
}

// An empty field means the default 0.5 %. The result is in basis points, hence 2 decimals.
export function parseTolerance(toleranceInput: string): ToleranceResult {
  const tolerance = parseAmount(toleranceInput === "" ? "0.5" : toleranceInput, 2);
  if (tolerance === null || tolerance < 0) {
    return {tolerance: null, reason: "Invalid tolerance"};
  }
  if (tolerance > 10000n) {
    return {tolerance: null, reason: "Tolerance cannot exceed 100%"};
  }
  return {tolerance, reason: null};
}

// V.5/bug-addliquidity-rounding — `Math.ceilDiv` from Solidity, mirrored here.
// The deposit pro-rata uses ceiling division on the amounts the pool pulls:
// `Math.ceilDiv(_amount * cachedReserves[i], cachedReserves[anchor])`. The
// frontend's quote previously used integer division (floor), which produced an
// amount 1 unit short whenever the ratio wasn't exact — and the pool's `safeTransferFrom`
// then reverted with `ERC20InsufficientAllowance`. Quote and contract MUST use the
// same rounding; this is the only place to keep them aligned.
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("ceilDiv by 0");
  // JS BigInt division truncates toward zero. Math.ceil(a/b) is a/b rounded AWAY
  // from zero when not exact — +1 when the signs agree, +0 when they differ.
  // Exact divisions return the truncated quotient directly.
  const q = numerator / denominator;
  return numerator % denominator === 0n
    ? q
    : (numerator > 0n) === (denominator > 0n) ? q + 1n : q;
}
