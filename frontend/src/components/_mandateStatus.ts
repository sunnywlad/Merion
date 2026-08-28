/**
 * Statut temporel du mandat, partagé entre `AuctionBar` (résumé) et
 * `MandatePanel` (détail). Avant cette tâche, les deux calculaient la
 * même formule inline — un risque de dérive que la passe ferme ici.
 *
 * Le préfixe `_` sur le nom du fichier signale « interne au dossier
 * `components/`, pas un export public ». Aucun composant applicatif
 * hors du périmètre de l'enchère ne devrait importer ce fichier.
 */

export type MandateTimelineStatus = 'new' | 'active' | 'late' | 'closed';

/**
 * Fenêtre tardive = 15 % de la durée totale du mandat (note §11, proxy
 * jusqu'à ce que le contrat expose une constante dédiée). Constante
 * exportée pour qu'un éventuel changement soit isolé à un seul endroit.
 */
export const LATE_WINDOW_FRACTION = 0.15;

/**
 * Calcule la fenêtre tardive en secondes à partir de la durée totale du
 * mandat. Renvoie `undefined` si la durée n'est pas connue.
 */
export function computeLateWindow(
  durationSeconds: number | undefined,
): number | undefined {
  if (durationSeconds === undefined) return undefined;
  return Math.floor(durationSeconds * LATE_WINDOW_FRACTION);
}

/**
 * Statut temporel du mandat courant. Renvoie `'closed'` tant que les
 * bornes ne sont pas chargées — c'est l'état sûr (la timeline n'invente
 * jamais une phase).
 *
 * Formule :
 *   now <  start              → 'new'      (mandate hasn't begun)
 *   now ≤  end - lateWindow   → 'active'   (body phase)
 *   now <  end                → 'late'     (late window)
 *   sinon                     → 'closed'
 */
export function computeMandateStatus(args: {
  now: bigint | null;
  start: bigint | undefined;
  end: bigint | undefined;
  lateWindow: number | undefined;
}): MandateTimelineStatus {
  const { now, start, end, lateWindow } = args;
  if (
    start === undefined ||
    end === undefined ||
    lateWindow === undefined ||
    now === null
  ) {
    return 'closed';
  }
  const nowSec = Number(now);
  const startSec = Number(start);
  const endSec = Number(end);
  if (nowSec < startSec) return 'new';
  if (nowSec <= endSec - lateWindow) return 'active';
  if (nowSec < endSec) return 'late';
  return 'closed';
}
