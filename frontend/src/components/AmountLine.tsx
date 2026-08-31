import { formatAmount, type Grouping } from '@/components/ui/formatAmount';

type AmountLineProps = {
  label: string;
  isLoading: boolean;
  error: Error | null | undefined;
  value: bigint | undefined;
  /** Decimales on-chain (encodage de `value`). Defaut 8. */
  tokenDecimals?: number;
  /** Precision d'affichage (decimales montrees). Tronquee, pas arrondie. Defaut 4. */
  displayDecimals?: number;
  /** Style de groupement. Defaut 'none'. 'fr' pour les montants MRN. */
  grouping?: Grouping;
  /**
   * Unite affichee apres la valeur.
   *   - `wBTC`, `MRN`, `h` : rendu en `<span>` séparé, Code Small Neutral,
   *     avec espace insécable (NARROW NO-BREAK SPACE) devant — l'unité NE
   *     fait PAS partie de la colonne de chiffres alignée.
   *   - `%` : rendu en ligne dans le bloc mono, collé sans espace, parce
   *     que la convention distingue `%` intra-mono (`39,61%`) du `%` hors
   *     mono (rail Small : `39,61 %`).
   */
  unit?: string;
};

/**
 * Ligne de montant Merion.
 *
 * `font-variant-numeric: tabular-nums` aligne la colonne de chiffres (balances du rail,
 * reserves, pourcentages). L'unite est hors de cette colonne, sauf `%`, que la spec colle au bloc mono.
 *
 * Les quatre etats sont evalues dans l'ordre : pendant le chargement, `value` est aussi
 * undefined, et la troisieme branche volerait l'affichage a la premiere — une
 * valeur numerique ne porte pas de couleur semantique par defaut.
 */
export default function AmountLine({
  label,
  isLoading,
  error,
  value,
  tokenDecimals = 8,
  displayDecimals = 4,
  grouping = 'none',
  unit,
}: AmountLineProps) {
  let content: string;
  let contentClass: string;
  if (isLoading) {
    content = 'Loading…';
    contentClass = 'text-cloud/60';
  } else if (error) {
    // Volontairement pas le message d'erreur : cette cellule est une colonne de chiffres
    // etroite, une phrase casserait l'alignement. Le libelle complet est porte par
    // `ReadErrorBoundary`, ou la place le permet.
    content = 'Read failed';
    contentClass = 'text-danger';
  } else if (value === undefined) {
    content = '—';
    contentClass = 'text-cloud/60';
  } else {
    content = formatAmount(value, {
      displayDecimals,
      tokenDecimals,
      grouping,
    });
    contentClass = 'text-cloud';
  }

  // `%` reste colle dans le bloc mono ; toute autre unite a son propre span precede
  // d'une espace fine insecable, pour garder la colonne de chiffres alignee verticalement.
  const inlineUnit = unit === '%';

  return (
    <li className="flex items-baseline justify-between gap-4 py-1 text-body">
      <span className="text-cloud/80">{label}</span>
      <span className="flex items-baseline min-w-0">
        <span
          className={`font-mono text-code num-tabular ${contentClass}`}
        >
          {content}
          {inlineUnit ? unit : ''}
        </span>
        {!inlineUnit && unit ? (
          <span className="font-mono text-code-sm text-neutral">
            {' '}
            {unit}
          </span>
        ) : null}
      </span>
    </li>
  );
}
