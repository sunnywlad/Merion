import type { MandateTimelineStatus } from '@/components/_mandateStatus';

export type { MandateTimelineStatus };

type MandateTimelineProps = {
  /** Debut du mandat, en secondes depuis l'epoque. */
  start: number;
  /** Fin du mandat, en secondes depuis l'epoque. */
  end: number;
  /** Instant present, en secondes depuis l'epoque. */
  now: number;
  /**
   * Duree de la fenetre d'enchere (`auctionWindow` du contrat), en secondes,
   * comptee depuis le debut du mandat. C'est la seule tranche ou `placeBid`
   * est accepte. Defaut 0 : pas de zone tant que la constante n'est pas lue.
   */
  bidWindow?: number;
  /** Statut calcule par l'appelant a partir de start/end/now. */
  status: MandateTimelineStatus;
  className?: string;
};

const DEFAULT_BID_WINDOW = 0;

const STATUS_LABEL: Record<MandateTimelineStatus, string> = {
  new: 'New',
  active: 'Active',
  late: 'Late window',
  closed: 'Closed',
};

/**
 * Merion mandate timeline — note d'inspiration §11, différenciateur du
 * produit. La frise encode deux zones contiguës (bid / body), le
 * curseur du présent qui glisse le long de la timeline, et un badge
 * de statut en haut à droite.
 *
 * **Zones** : `bid` (turquoise) couvre les `auctionWindow` premières
 * secondes du mandat, la seule tranche où `placeBid` est accepté par le
 * contrat ; `body` (merion-blue) le reste du mandat. Aucune zone `late`
 * ni `silence` : ni l'une ni l'autre n'a de contrepartie on-chain. Les
 * transitions entre zones sont NETTES. Le curseur du présent est animé
 * en CSS (transition sur `left`, 250 ms), neutralisée par
 * `prefers-reduced-motion` dans `globals.css`.
 *
 * Le composant reste « dumb » sur l'état contrat : le caller passe
 * `start`, `end`, `now`, `bidWindow`, `status`. Aucun hook ne vit ici.
 */
export function MandateTimeline({
  start,
  end,
  now,
  bidWindow = DEFAULT_BID_WINDOW,
  status,
  className = '',
}: MandateTimelineProps) {
  const total = Math.max(1, end - start);
  const bidFrac = Math.max(0, Math.min(1, bidWindow / total));
  const bodyFrac = Math.max(0, 1 - bidFrac);
  // Le curseur sort un peu en dehors de la bande (`-bottom-1`) pour qu'on
  // le voie aussi quand `cursorPercent` tombe pile sur 0 ou 100. La
  // position est bornée dans `[0, 100]`.
  const cursorPercent = Math.max(0, Math.min(100, ((now - start) / total) * 100));

  return (
    <div
      data-status={status}
      aria-label={`Epoch timeline, status ${STATUS_LABEL[status]}`}
      className={`merion-timeline relative w-full ${className}`}
    >
      <div className="pt-4">
        <div className="relative h-3 w-full">
          {/* Deux zones contiguës : fenêtre d'enchère (turquoise, seule
              tranche où `placeBid` passe) puis corps du mandat
              (merion-blue). Coins arrondis portés par le conteneur pour
              rester nets. L'opacité dépend du `data-status` (globals.css). */}
          <div className="absolute inset-0 flex overflow-hidden rounded-full">
            <div
              className="merion-timeline-zone-bid h-full bg-turquoise"
              style={{ width: `${bidFrac * 100}%` }}
              aria-hidden="true"
            />
            <div
              className="merion-timeline-zone-body h-full bg-merion-blue"
              style={{ width: `${bodyFrac * 100}%` }}
              aria-hidden="true"
            />
          </div>

          {/* Curseur du présent — transition CSS sur `left` pour que le
              tick seconde-par-seconde glisse au lieu de téléporter. */}
          <div
            className="merion-timeline-cursor absolute top-0 -bottom-1 w-0.5 bg-cloud -translate-x-1/2 pointer-events-none"
            style={{ left: `${cursorPercent}%` }}
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}
