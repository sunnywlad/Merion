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

// An empty field means the default 0.5 %. The result is in basis points, hence 2 decimals.
export function parseTolerance(toleranceInput: string): ToleranceResult {
  const tolerance = parseAmount(toleranceInput === "" ? "0.5" : toleranceInput, 2);
  if (tolerance === null || tolerance < 0) {
    return {tolerance: null, reason: "Tolérance invalide"};
  }
  if (tolerance > 10000n) {
    return {tolerance: null, reason: "La tolérance ne peut pas dépasser 100 %"};
  }
  return {tolerance, reason: null};
}
