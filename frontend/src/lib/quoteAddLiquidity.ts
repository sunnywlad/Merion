import { formatUnits } from "viem";
import { parseAmount } from "@/lib/parseAmount";
import { ceilDiv, parseTolerance, type QuoteResult } from "@/lib/quote";

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

  // La tolerance est jugee en premier : champ a part, elle doit repondre meme sur un formulaire vide.
  const {tolerance, reason: toleranceReason} = parseTolerance(toleranceInput);
  if (tolerance === null) return {quote: null, reason: toleranceReason};

  // Formulaire incomplet : rien a dire.
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
  // Reproduire le Math.ceilDiv du contrat sur les trois montants
  // prélevés. La division au plancher rendrait ici, pour tout token non-ancre, un montant 1 unité
  // trop court dès que `amount * reserves[i]` n'est pas divisible par `anchorReserve` ; le
  // safeTransferFrom reverterait alors avec ERC20InsufficientAllowance. Le bootstrap est exact
  // (3 depots egaux) et traité separement ci-dessus.
  const computed: [bigint, bigint, bigint] = [
    ceilDiv(amount * reserves[0], anchorReserve),
    ceilDiv(amount * reserves[1], anchorReserve),
    ceilDiv(amount * reserves[2], anchorReserve)
  ];
  // `expected` : les parts LP que le pool va emettre. Le contrat les calcule au plancher
  // (le minimum pour l'utilisateur), le devis fait pareil.
  const expected = supply * amount / anchorReserve;
  const minExpected = expected * (10000n - tolerance) / 10000n;
  return {quote: {computed, expected, minExpected}, reason: null};
}
