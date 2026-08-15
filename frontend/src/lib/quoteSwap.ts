import { formatUnits } from "viem";
import { parseAmount } from "@/lib/parseAmount";
import { parseTolerance, type QuoteResult } from "@/lib/quote";

export type Quote = {
  tokenIn: { index: 0 | 1 | 2, amount: bigint },
  tokenOut: { index: 0 | 1 | 2, amount: bigint, minAmount: bigint };
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

    const tokenIn = {index : indexIn, amount: amountIn};
    const tokenOut = {index: indexOut, amount: amountOut, minAmount: amountOut * (10000n - tolerance) / 10000n}

    return {quote: {tokenIn, tokenOut}, reason: null};
}
