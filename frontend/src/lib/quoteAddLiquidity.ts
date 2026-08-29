import { formatUnits } from "viem";
import { parseAmount } from "@/lib/parseAmount";
import { parseTolerance, type QuoteResult } from "@/lib/quote";

export type Quote = {
  computed: [bigint, bigint, bigint];
  expected: bigint;
  minExpected: bigint;
};

export const getQuote = ({
  anchor,
  typedAmount,
  toleranceInput,
  reserves,
  supply,
  minLiq}:
  {anchor: 0 | 1 | 2 | null,
  typedAmount: string,
  toleranceInput: string,
  reserves: readonly bigint[],
  supply: bigint,
  minLiq: bigint | undefined}): QuoteResult<Quote> => {

  // The tolerance is judged first: it is a field of its own, it must speak even on an empty form.
  const {tolerance, reason: toleranceReason} = parseTolerance(toleranceInput);
  if (tolerance === null) return {quote: null, reason: toleranceReason};

  // Unfinished form: nothing to say.
  if (anchor === null || !typedAmount) return {quote: null, reason: null};

  const amount = parseAmount(typedAmount);
  if (amount === null || amount < 0) {
    return {quote: null, reason: "Invalid amount"};
  }
  if (amount === 0n) return { quote: null, reason: "Amount too small"}

  if (supply === 0n) {
    if (minLiq === undefined) return {quote: null, reason: null};
    const expected = 3n * amount - minLiq;
    if (expected <= 0n) {
      return {quote: null, reason: `Initial deposit too small — at least ${formatUnits(minLiq / 3n, 8)} per token`};
    }
    return {quote: {computed: [amount, amount, amount], expected, minExpected: expected}, reason: null};
  }

  const anchorReserve = reserves[anchor];
  const computed: [bigint, bigint, bigint] = [
    amount * reserves[0] / anchorReserve,
    amount * reserves[1] / anchorReserve,
    amount * reserves[2] / anchorReserve
  ];
  const expected = supply * amount / anchorReserve;
  const minExpected = expected * (10000n - tolerance) / 10000n;
  return {quote: {computed, expected, minExpected}, reason: null};
}
