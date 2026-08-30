type ReservesBarProps = {
  // Libelle du token, a gauche de la barre (ex. « wBTC »).
  tokenSymbol: string;
  // Part actuelle du pool, 0..1 (ex. 0,334 pour 33,4 %).
  share: number;
  // Corridor acceptable autour de la cible de 33 %. Hors bande, le remplissage passe en Warning.
  // Defaut ±4 pp autour de 1/3 : assez large pour que les petits desequilibres restent nominaux,
  // assez serre pour signaler une derive nette.
  bound?: { low: number; high: number };
  className?: string;
};

const DEFAULT_BOUND = { low: 1 / 3 - 0.04, high: 1 / 3 + 0.04 };
const TARGET_FRACTION = 1 / 3;

/**
 * Barre de reserves Merion — une barre horizontale : part du token, marque de cible a 33 %,
 * remplissage code couleur.
 *
 * Rendu CSS pur (ni SVG ni canvas). Transition de largeur sur 300 ms ; la couleur suit la
 * meme duree.
 *
 * Accessibilite : `role="meter"` avec `aria-valuenow / valuemin / valuemax` pour que les
 * lecteurs d'ecran annoncent la part ; le tick de cible est decoratif (`aria-hidden`).
 */
export function ReservesBar({
  tokenSymbol,
  share,
  bound = DEFAULT_BOUND,
  className = '',
}: ReservesBarProps) {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  // `share === 0` couvre deux cas : reserves vraiment nulles (pool vide) et `reserves` pas
  // encore charge. Les deux rendent un remplissage neutre : jamais de Warning sur donnee absente.
  const noData = share === 0;
  const outOfBounds =
    !noData && (share < bound.low || share > bound.high);
  const fillClass = noData
    ? 'bg-neutral'
    : outOfBounds
      ? 'bg-warning'
      : 'bg-merion-blue';

  return (
    <div className={`flex flex-col gap-1 min-w-0 ${className}`}>
      <div className="flex items-baseline justify-between gap-2 text-body-lg">
        <span className="text-cloud/80">{tokenSymbol}</span>
        <span className="font-mono text-code-lg text-cloud">
          {pct.toFixed(2)}%
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${tokenSymbol} pool share`}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-2 rounded bg-slate overflow-hidden"
      >
        <div
          className={`absolute inset-y-0 left-0 transition-[width,background-color] duration-300 ease-out ${fillClass}`}
          style={{ width: `${pct}%` }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-y-0 w-0.5 bg-cloud/60"
          style={{ left: `${TARGET_FRACTION * 100}%` }}
        />
      </div>
    </div>
  );
}

export default ReservesBar;