/**
 * Barre de decomposition du swap Merion — II.4 / V.4.
 *
 * Barre horizontale a deux zones qui oppose la perte CERTAINE du swap (fee + impact de prix)
 * a sa perte POTENTIELLE (tampon de slippage). Le traitement visuel distingue les deux
 * categories sans lire la legende : merion-blue plein pour le certain, turquoise raye pour le potentiel.
 *
 * Les valeurs viennent de `quoteSwap` :
 *   - `fee` (unites d'entree, bigint 8-decimales)
 *   - `priceImpact` (unites de sortie, bigint 8-decimales — converti via `amountOut`)
 *   - `slippage` (tolerance en pourcent, ex. 0,5)
 *   - `input` (montant d'entree, bigint 8-decimales)
 *
 * Affichage des montants : `formatAmount` avec `displayDecimals: 8` (precision
 * on-chain des BTC wrappes). On tranche au plus court : 0.5 reste « 0.50000000 »,
 * un impact sub-display (0.00012345 BTC) reste lisible jusqu'au 8e chiffre.
 * C'est le seul endroit de l'app qui montre la precision complete du trade.
 *
 * Sans devis (input == 0n, ou un segment undefined / NaN), la barre rend un etat vide neutre
 * avec le label « Awaiting quote ».
 */
import { formatAmount } from '@/components/ui/formatAmount';

type SwapDecompositionBarProps = {
  /** Montant d'entree en unites on-chain (8 decimales). */
  input: bigint;
  /** Fee prelevee sur l'entree, en unites on-chain (8 decimales). */
  fee: bigint;
  /** Impact de prix, en unites de SORTIE (8 decimales — voir amountOut pour la conversion). */
  priceImpact: bigint;
  /** Tolerance de slippage, en pourcent (0,5 = 0,5 %). */
  slippage: number;
  /**
   * Montant de sortie attendu, optionnel. Present, l'impact en unites de sortie est converti
   * en son equivalent d'entree pour comparer les deux zones sur une seule echelle. Absent, la
   * barre utilise un ratio direct (largeur approximative).
   */
  amountOut?: bigint;
  /**
   * Suffixe ajoute a la valeur de perte certaine (ex. 'wBTC'). Couvre la fee ET l'impact de
   * prix : la legende convertit l'impact en unites d'entree pour n'afficher qu'un chiffre.
   */
  feeUnit?: string;
  /** Suffixe du label de slippage (defaut '%'). */
  slippageUnit?: string;
  className?: string;
};

/** Convertit un bigint 8-decimales en nombre flottant pour les ratios de largeur. */
const toFloat = (v: bigint): number => Number(v) / 1e8;

/** Formate un bigint 8-decimales en chaine, precision complete (cf. bloc ci-dessus). */
const fmt = (v: bigint): string =>
  formatAmount(v, { displayDecimals: 8, tokenDecimals: 8 });

export function SwapDecompositionBar({
  input,
  fee,
  priceImpact,
  slippage,
  amountOut,
  feeUnit = '',
  slippageUnit = '%',
  className = '',
}: SwapDecompositionBarProps) {
  const inputF = toFloat(input);
  const feeF = toFloat(fee);
  const impactF = toFloat(priceImpact);
  const amountOutF = amountOut !== undefined ? toFloat(amountOut) : undefined;

  const valid =
    Number.isFinite(inputF) && inputF > 0 &&
    Number.isFinite(feeF) && feeF >= 0 &&
    Number.isFinite(impactF) && impactF >= 0 &&
    Number.isFinite(slippage) && slippage >= 0;

  if (!valid) {
    return (
      <div className={`flex flex-col gap-2 ${className}`} aria-label="Awaiting quote">
        <div className="h-3 w-full overflow-hidden rounded bg-cloud/10" aria-hidden="true" />
        <p className="text-caption text-cloud/60">Awaiting quote</p>
      </div>
    );
  }

  // Chaque perte comme fraction de l'entree. `priceImpact` est libelle dans le token de SORTIE
  // (voir `quoteSwap.ts`) ; on convertit via le taux spot `input / amountOut` pour ramener les
  // trois valeurs sur une seule echelle.
  const feeW = feeF / inputF;
  const impactW = amountOutF !== undefined && amountOutF > 0
    ? impactF / amountOutF
    : impactF / inputF;
  const slippageW = slippage / 100;

  // Les deux zones. `certain` : ce que le swap coutera a coup sur. `potential` : la perte
  // supplementaire acceptee en fixant une tolerance de slippage. Toutes deux fractions de l'entree.
  const certainW = feeW + impactW;
  const potentialW = slippageW;
  const totalW = certainW + potentialW;

  // Quand les deux zones cumulees depassent 100 % de l'entree, l'utilisateur accepte un pire
  // cas superieur au trade entier : on cerne la barre d'un contour warning et on met les deux
  // zones a l'echelle pour qu'elles tiennent.
  const overDeadBand = totalW > 1;
  const scale = overDeadBand && totalW > 0 ? 1 / totalW : 1;

  // Pour la legende : perte certaine en unites d'ENTREE, pour n'afficher qu'un chiffre plutot
  // que deux dans des tokens differents. `priceImpact` converti via le taux spot
  // `input / amountOut` en arithmetique bigint pure (pas de `Math.round` qui tronque un ULP).
  const impactInInput = amountOut !== undefined && amountOut > 0n
    ? (priceImpact * input) / amountOut
    : priceImpact;
  const certainInInput = fee + impactInInput;

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div
        className={`flex h-3 w-full overflow-hidden rounded ${
          overDeadBand ? 'ring-1 ring-warning' : ''
        }`}
        role="img"
        aria-label={
          `Swap decomposition: certain ${fmt(certainInInput)}${feeUnit ? ' ' + feeUnit : ''}` +
          `, potential ${trim(slippage)}${slippageUnit}`
        }
      >
        {/* CERTAIN — fee + impact de prix, merion-blue plein */}
        <div
          className="merion-decomp-segment bg-merion-blue"
          style={{ width: `${certainW * scale * 100}%` }}
          title={`Certain: ${fmt(certainInInput)}${feeUnit ? ' ' + feeUnit : ''} (fee + price impact)`}
        />
        {/* POTENTIEL — tampon de slippage, turquoise raye */}
        <div
          className="merion-decomp-segment bg-turquoise/40"
          style={{
            width: `${potentialW * scale * 100}%`,
            backgroundImage:
              'repeating-linear-gradient(45deg, transparent 0 4px, rgba(45,212,191,0.55) 4px 8px)',
          }}
          title={`Potential: ${trim(slippage)}${slippageUnit} (max extra if market moves)`}
        />
        {/* Reste non echange de l'entree — remplissage clair, seulement si les deux zones tiennent. */}
        {!overDeadBand && certainW + potentialW < 1 ? (
          <div
            className="merion-decomp-segment bg-cloud/10"
            style={{ width: `${(1 - certainW - potentialW) * 100}%` }}
            aria-hidden="true"
          />
        ) : null}
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption">
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-merion-blue" />
          <span className="text-cloud/70">Certain</span>
          <span className="font-mono text-code-sm text-cloud">
            {fmt(certainInInput)}{feeUnit ? ' ' + feeUnit : ''}
          </span>
          <span className="text-cloud/50">(fee + impact)</span>
        </li>
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-sm bg-turquoise/60"
            style={{
              backgroundImage:
              'repeating-linear-gradient(45deg, transparent 0 2px, rgba(45,212,191,0.8) 2px 3px)',
            }}
          />
          <span className="text-cloud/70">Potential</span>
          <span className="font-mono text-code-sm text-cloud">
            {trim(slippage)}{slippageUnit}
          </span>
          <span className="text-cloud/50">(max extra)</span>
        </li>
      </ul>
    </div>
  );
}

/** Tronque un nombre flottant en enlevant les zéros de fin : 0.025000 -> 0.025, 1.000000 -> 1. */
function trim(n: number, max = 6): string {
  if (!Number.isFinite(n)) return '—';
  const fixed = n.toFixed(max);
  return fixed.replace(/\.?0+$/, '') || '0';
}

export default SwapDecompositionBar;