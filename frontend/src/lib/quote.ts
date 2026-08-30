import { parseAmount } from "@/lib/parseAmount";

// Un devis null : aucune transaction n'est encore constructible.
// reason n'est rempli que si l'utilisateur s'est trompe ; un formulaire incomplet reste muet.
export type QuoteResult<Q> =
  | {quote: Q, reason: null}
  | {quote: null, reason: string | null};

// Meme forme discriminee que QuoteResult : une tolerance null porte toujours sa raison.
export type ToleranceResult =
  | {tolerance: bigint, reason: null}
  | {tolerance: null, reason: string};

// Part de `part` dans `whole`, en points de base (formatUnits(_, 2) -> pourcentage).
// whole nul -> 0 plutot qu'une exception : seul un swap de zero y mene, ou tout vaut zero.
export function shareBps(part: bigint, whole: bigint): bigint {
  return whole === 0n ? 0n : part * 10000n / whole;
}

// Champ vide -> tolerance par defaut de 0,5 %. Resultat en bps (2 decimales).
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

// Division au superieur, copie de Math.ceilDiv de Solidity.
// Le pro-rata de depot du pool arrondit au superieur les montants preleves ; le front doit
// utiliser le meme arrondi, sinon le montant est 1 unite trop court et safeTransferFrom revert
// avec ERC20InsufficientAllowance. Seul endroit ou garder devis et contrat alignes.
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("ceilDiv by 0");
  // La division BigInt tronque vers zero. On ajoute 1 quand le reste est non nul et les signes concordent.
  const q = numerator / denominator;
  return numerator % denominator === 0n
    ? q
    : (numerator > 0n) === (denominator > 0n) ? q + 1n : q;
}
