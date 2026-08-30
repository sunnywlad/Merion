import { formatUnits } from "viem";
import { parseAmount } from "@/lib/parseAmount";
import { parseTolerance, shareBps, type QuoteResult } from "@/lib/quote";

export type Quote = {
  // tokenIn : la fee est prelevee sur le montant ENVOYE, avant la courbe.
  // Les pourcentages sont en points de base (bps), rendus via formatUnits(_, 2).
  tokenIn: { index: 0 | 1 | 2, amount: bigint, fee: bigint, feeBps: bigint },
  // tokenOut : priceImpact est exprime dans le token RECU, mesure contre le ratio spot des reserves.
  tokenOut: { index: 0 | 1 | 2, amount: bigint, minAmount: bigint, priceImpact: bigint, priceImpactBps: bigint };
};

export const getQuote = ({
  userAsk: {side, typedAmount, indexIn, indexOut, toleranceInput},
  poolState: {reserves, effectiveFeeNum, feeDen}
  }: {
    userAsk: {side: 'in' | 'out' | null,
      typedAmount: string,
      indexIn: 0 | 1 | 2,
      indexOut: 0 | 1 | 2,
      toleranceInput: string},
    poolState: {reserves: readonly bigint[],
      // Numerateur de fee reellement applique pour CETTE direction (effectiveFeeNum(in, out)).
      // Pas feeInForce() ni le slot brut feeNum : le pool surtaxe la direction qui aggrave
      // le desequilibre, donc un devis base sur le taux de base sous-facture ces trades.
      effectiveFeeNum: bigint,
      feeDen: bigint}
  }): QuoteResult<Quote> => {

    // La tolerance est jugee en premier : champ a part, elle doit repondre meme sur un formulaire vide.
    const {tolerance, reason: toleranceReason} = parseTolerance(toleranceInput);
    if (tolerance === null) return {quote: null, reason: toleranceReason};

    // Formulaire incomplet : rien a dire.
    if (!side || !typedAmount) return {quote: null, reason: null};

    const amount = parseAmount(typedAmount);
    if (amount===null || amount < 0) {
      return {quote: null, reason: "Invalid amount"};
    }
    if (!reserves[indexIn] || reserves[indexOut] === 0n) return {quote: null, reason: "Empty reserve"};

    let amountIn;
    let amountOut;

    if (side === 'in') {
      // Sens 'in' : on connait l'entree, on calcule la sortie apres fee via la courbe x*y=k.
      amountIn = amount;
      const amountAfterFee =  amountIn * (feeDen - effectiveFeeNum) / feeDen;
      amountOut = amountAfterFee * reserves[indexOut] / (amountAfterFee + reserves[indexIn]);
    } else {
      // Sens 'out' : on connait la sortie voulue, on remonte l'entree necessaire (arrondi au superieur).
      amountOut = amount;
      if (amountOut >= reserves[indexOut]) return {quote: null, reason: `Not enough reserve for this trade — max ${formatUnits(reserves[indexOut] - 1n, 8)}`};
      const num = feeDen * amountOut * reserves[indexIn];
      const den = (feeDen - effectiveFeeNum) * (reserves[indexOut] - amountOut);
      amountIn = (num + den - 1n) / den;
    }

    // Recalcule ici pour reproduire la troncature du contrat cote entree (la branche 'out' ne l'avait pas).
    const amountAfterFee = amountIn * (feeDen - effectiveFeeNum) / feeDen;
    const fee = amountIn - amountAfterFee;

    // Sortie ideale : ce que donnerait un trade infiniment petit au ratio spot. La sortie reelle est
    // toujours inferieure. Derivee du montant apres fee pour que fee et impact se partagent l'ecart sans doublon.
    const idealOut = amountAfterFee * reserves[indexOut] / reserves[indexIn];
    // Garde : en sens 'out' amountIn est arrondi au superieur, un ecart d'un wei pourrait inverser la comparaison.
    const priceImpact = idealOut > amountOut ? idealOut - amountOut : 0n;

    // Chaque perte est rapportee a sa propre base : la fee au montant envoye, l'impact a la sortie ideale.
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
