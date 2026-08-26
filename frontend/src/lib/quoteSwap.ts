import { formatUnits } from "viem";
import { parseAmount } from "@/lib/parseAmount";
import { parseTolerance, shareBps, type QuoteResult } from "@/lib/quote";

export type Quote = {
  // `fee` is denominated in the INPUT token: the pool skims it off what you send, before the
  // curve ever sees the amount.
  // Percentages are carried as basis points, like the tolerance: `formatUnits(_, 2)` renders them.
  tokenIn: { index: 0 | 1 | 2, amount: bigint, fee: bigint, feeBps: bigint },
  // `priceImpact` is denominated in the OUTPUT token: what the curve costs you on top of the
  // fee, measured against the spot ratio of the reserves.
  tokenOut: { index: 0 | 1 | 2, amount: bigint, minAmount: bigint, priceImpact: bigint, priceImpactBps: bigint };
};

export const getQuote = ({
  userAsk: {side, typedAmount, indexIn, indexOut, toleranceInput},
  poolState: {reserves, feeNum, feeDen}
  }: {
    userAsk: {side: 'in' | 'out' | null,
      typedAmount: string,
      indexIn: 0 | 1 | 2,
      indexOut: 0 | 1 | 2,
      toleranceInput: string},
    poolState: {reserves: readonly bigint[],
      // The fee numerator IN FORCE for the current mandate, i.e. `feeInForce()`, not the raw
      // `feeNum` storage slot: outside the mandate that wrote it, the pool charges the nominal
      // rate, and only the view accounts for that.
      feeNum: bigint,
      feeDen: bigint}
  }): QuoteResult<Quote> => {

    // The tolerance is judged first: it is a field of its own, it must speak even on an empty form.
    const {tolerance, reason: toleranceReason} = parseTolerance(toleranceInput);
    if (tolerance === null) return {quote: null, reason: toleranceReason};

    // Unfinished form: nothing to say.
    if (!side || !typedAmount) return {quote: null, reason: null};

    const amount = parseAmount(typedAmount);
    if (amount===null || amount < 0) {
      return {quote: null, reason: "Montant invalide"};
    }
    if (!reserves[indexIn] || reserves[indexOut] === 0n) return {quote: null, reason: "Réserve vide"};

    let amountIn;
    let amountOut;

    if (side === 'in') {
      amountIn = amount;
      const amountAfterFee =  amountIn * (feeDen - feeNum) / feeDen;
      amountOut = amountAfterFee * reserves[indexOut] / (amountAfterFee + reserves[indexIn]);
    } else {
      amountOut = amount;
      if (amountOut >= reserves[indexOut]) return {quote: null, reason: `Réserve insuffisante pour cette opération, max : ${formatUnits(reserves[indexOut] - 1n, 8)}`};
      const num = feeDen * amountOut * reserves[indexIn];
      const den = (feeDen - feeNum) * (reserves[indexOut] - amountOut);
      amountIn = (num + den - 1n) / den;
    }

    // Recomputed here rather than carried out of the branch above: the 'out' branch never held
    // it, and this line reproduces the contract's own truncation on the input side.
    const amountAfterFee = amountIn * (feeDen - feeNum) / feeDen;
    const fee = amountIn - amountAfterFee;

    // What the swap would yield if the pool traded at the spot ratio of its reserves, that is,
    // if the trade were infinitely small. The real output is always lower, the curve sees the
    // trade coming. `idealOut` is derived from the post-fee amount so the two figures do not
    // count the same loss twice: fee and impact partition the gap exactly.
    const idealOut = amountAfterFee * reserves[indexOut] / reserves[indexIn];
    // Guarded rather than assumed: on the 'out' branch `amountIn` was rounded UP in the pool's
    // favour, and a one-wei quote could invert the comparison. A negative loss is nonsense to
    // display.
    const priceImpact = idealOut > amountOut ? idealOut - amountOut : 0n;

    // Each loss is measured against the quantity it is actually taken from: the fee against what
    // you send, the impact against what you would have received without the curve. Referring both
    // to the same base would flatter one of the two.
    const tokenIn = {index : indexIn, amount: amountIn, fee, feeBps: shareBps(fee, amountIn)};
    const tokenOut = {
      index: indexOut,
      amount: amountOut,
      minAmount: amountOut * (10000n - tolerance) / 10000n,
      priceImpact,
      priceImpactBps: shareBps(priceImpact, idealOut)
    }

    return {quote: {tokenIn, tokenOut}, reason: null};
}
