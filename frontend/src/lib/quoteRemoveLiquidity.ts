import { parseAmount } from "@/lib/parseAmount";
import { parseTolerance, type QuoteResult } from "@/lib/quote";

export type Quote = {
  expected: [bigint, bigint, bigint];
  shares: bigint;
  minExpected: [bigint, bigint, bigint];
};

export const getQuote = ({
  anchor,
  typedAmount,
  toleranceInput,
  reserves,
  supply,
  maxShares}:
  {anchor: 0 | 1 | 2 | 3 | null,
  typedAmount: string,
  toleranceInput: string,
  reserves: readonly bigint[],
  supply: bigint,
  maxShares: bigint | undefined}): QuoteResult<Quote> => {

    // The tolerance is judged first: it is a field of its own, it must speak even on an empty form.
    const {tolerance, reason: toleranceReason} = parseTolerance(toleranceInput);
    if (tolerance === null) return {quote: null, reason: toleranceReason};

    // Unfinished form: nothing to say.
    if (anchor === null || !typedAmount) return {quote: null, reason: null};

    if (maxShares === undefined) return {quote: null, reason: null}

    const amount = parseAmount(typedAmount);
    if (amount===null || amount < 0) {
      return {quote: null, reason: "Invalid amount"};
    }

    if (supply === 0n) return { quote: null, reason: "The pool is empty"}


    const reservesA = [...reserves, supply] as const;
    const anchorReserve = reservesA[anchor];
    const shares = amount * supply / anchorReserve;

    if (shares === 0n) return { quote: null, reason: "Amount too small — nothing to burn"}
    if (shares > maxShares) return { quote: null, reason: "You don't have enough LP shares"};

    const expected: [bigint, bigint, bigint] = [
      shares * reserves[0] / supply,
      shares * reserves[1] / supply,
      shares * reserves[2] / supply
    ];
    const minExpected: [bigint, bigint, bigint] = [
      expected[0] * (10000n - tolerance) / 10000n,
      expected[1] * (10000n - tolerance) / 10000n,
      expected[2] * (10000n - tolerance) / 10000n
    ];
    return {quote: {expected, shares, minExpected}, reason: null};
}
