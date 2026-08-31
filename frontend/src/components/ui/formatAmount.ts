import { formatUnits } from 'viem';

/**
 * Formatteurs de nombres cote affichage pour Merion.
 *
 * Regles :
 *   - BTC wrappes (wBTC, cbBTC, LBTC) — 4 decimales, tronquees, sans groupement.
 *   - MRN — 2 decimales, groupement francais (« 90 004 980,00 »), tronquees.
 *   - Pourcentages (part de pool, fees) — 2 decimales, suffixe `%`.
 *
 * `value` est le bigint on-chain ; on lit `tokenDecimals` on-chain (8 pour les mocks wBTC,
 * 18 pour MRN) et ALORS SEULEMENT on tronque a la precision d'affichage. Troncature deliberee :
 * arrondir au superieur laisserait un solde affiche depasser le solde reel.
 */

export type Grouping = 'fr' | 'none';

export type FormatAmountOptions = {
  /** Nombre de decimales a afficher. Tronquees, pas arrondies. */
  displayDecimals: number;
  /** Decimales on-chain (encodage de `value`). */
  tokenDecimals: number;
  /** Style de groupement de la chaine affichee. Defaut 'none'. */
  grouping?: Grouping;
};

/** Tronque `value` a `decimals` decimales, sans arrondi. */
export function truncate(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.trunc(value * factor) / factor;
}

/**
 * Formate un nombre avec groupement francais (espace insecable pour les milliers, virgule decimale).
 *
 *   formatFr(1234567.89, 2) === "1 234 567,89"
 *   formatFr(-1234567.89, 2) === "-1 234 567,89"
 */
export function formatFr(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '—';
  const truncated = truncate(Math.abs(value), decimals);
  const sign = value < 0 ? '-' : '';
  const fixed = truncated.toFixed(decimals);
  const [intPart, fracPart = ''] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return fracPart.length > 0
    ? `${sign}${grouped},${fracPart}`
    : `${sign}${grouped}`;
}

/**
 * Formate `raw` (un bigint libelle en token) pour l'affichage.
 *
 * Rend '—' quand `raw` est undefined, quand `value` devient non fini (solde malforme), ou
 * quand une entree est invalide. N'invente jamais de valeur.
 */
export function formatAmount(
  raw: bigint | undefined,
  options: FormatAmountOptions,
): string {
  const { displayDecimals, tokenDecimals, grouping = 'none' } = options;
  if (raw === undefined) return '—';
  if (tokenDecimals < 0 || displayDecimals < 0) return '—';

  const textual = formatUnits(raw, tokenDecimals);
  const value = Number(textual);
  if (!Number.isFinite(value)) return textual;

  const truncated = truncate(value, displayDecimals);
  if (grouping === 'fr') return formatFr(truncated, displayDecimals);
  return truncated.toFixed(displayDecimals);
}

/**
 * Socle commun des formateurs adaptatifs en
 * 8 decimales (BTC wrappe et parts LP).
 *
 * Sous le seuil de 0,0001 (= 10 000 unités brutes), le 4-decimales
 * affiche `0.0000`, indiscernable d'un vrai zéro ; on bascule alors à
 * la precision on-chain complete (8 decimales) pour exposer la poussière.
 * Au-dessus, on garde 4 decimales pour la lisibilité.
 *
 * Le seuil est aligné sur l'unité d'affichage 4-decimales : tout ce qui
 * tombe à `0.0000` au 4-decimales déclenche le repli en 8 decimales.
 */
function smartEightDecimals(value: bigint | undefined): string {
  if (value === undefined) return '—';
  return value < 10000n
    ? formatAmount(value, { displayDecimals: 8, tokenDecimals: 8 })
    : formatAmount(value, { displayDecimals: 4, tokenDecimals: 8 });
}

/** Formateur BTC wrappe (8 decimales on-chain) pour Reserves / Balances. */
export function smartBtcAmount(value: bigint | undefined): string {
  return smartEightDecimals(value);
}

/**
 * Formateur des parts LP pour Balances.
 *
 * Les parts LP sont en 8 décimales, pas 18 :
 * `Pool.decimals()` rend 8 (fixe « to match the basket tokens »). Les
 * lire en 18 les afficherait 10^10 fois trop petites, donc `0.0000` pour
 * tout détenteur. Meme repli adaptatif que le BTC : sous 0,0001 LP on
 * passe à 8 décimales pour qu'un solde de 0,00001 LP reste lisible.
 */
export function smartLpAmount(value: bigint | undefined): string {
  return smartEightDecimals(value);
}
