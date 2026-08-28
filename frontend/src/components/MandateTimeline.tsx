import { Badge } from '@/components/ui/Badge';
import type { MandateTimelineStatus } from '@/components/_mandateStatus';

export type { MandateTimelineStatus };

type MandateTimelineProps = {
  /** Mandate start, in seconds since epoch. */
  start: number;
  /** Mandate end, in seconds since epoch. */
  end: number;
  /** Present moment, in seconds since epoch. */
  now: number;
  /**
   * Duration of the late bid window before `end`, in seconds. Defaults to
   * two hours, the brief's example value. The contract does not expose a
   * dedicated `lateWindow`; callers typically pass `15 %` of the mandate
   * duration as a proxy.
   */
  lateWindow?: number;
  /**
   * Duration of the post-close silence, in seconds. Defaults to 30 minutes.
   * Callers can pass `bidSilence` from the auction constants when available;
   * the fallback matches the brief's example proportion.
   */
  silence?: number;
  /** Caller-computed status from start/end/now. */
  status: MandateTimelineStatus;
  className?: string;
};

const DEFAULT_LATE_WINDOW = 2 * 60 * 60;
const DEFAULT_SILENCE = 30 * 60;

// Badge primitive variants. The brief assigns Info (#2563EB) to `new`, but
// the Badge primitive's `new` variant uses Merion Blue (#1E4BFF); the brand
// book treats the two as distinct, and the primitive does not expose an
// `info` variant. We keep the primitive and accept the substitution as a
// documented constraint.
const STATUS_VARIANT: Record<
  MandateTimelineStatus,
  'new' | 'active' | 'beta' | 'deprecated'
> = {
  new: 'new',
  active: 'active',
  late: 'beta',
  closed: 'deprecated',
};

const STATUS_LABEL: Record<MandateTimelineStatus, string> = {
  new: 'New',
  active: 'Active',
  late: 'Late window',
  closed: 'Closed',
};

/**
 * Merion mandate timeline — note d'inspiration §11, différenciateur du
 * produit. La frise encode trois zones contiguës (body / late / silence),
 * le curseur du présent qui glisse le long de la timeline, et un badge
 * de statut en haut à droite.
 *
 * **Distinction visuelle des zones** (note §11, tâche 5) : chaque phase
 * a son apparence propre via `data-status`. Les transitions entre
 * zones sont NETTES (un switch, jamais un gradient). Le curseur du
 * présent est animé en CSS (transition sur `left`, 250 ms) — c'est la
 * seule animation continue, neutralisée par le killswitch
 * `prefers-reduced-motion` dans `app/globals.css`.
 *
 * **Fenêtre tardive** : pendant `LATE`, la zone prend une emphase
 * visuelle (label `LAST 15%` posé au-dessus) et conserve sa couleur
 * `warning`. Le label reste discret — pas de pulsation, pas de
 * scintillement, juste un mot posé à un endroit stratégique.
 *
 * Le composant reste « dumb » sur l'état contrat : le caller passe
 * `start`, `end`, `now`, `lateWindow`, `silence`, `status`. Aucun
 * hook ne vit ici.
 */
export function MandateTimeline({
  start,
  end,
  now,
  lateWindow = DEFAULT_LATE_WINDOW,
  silence = DEFAULT_SILENCE,
  status,
  className = '',
}: MandateTimelineProps) {
  const total = Math.max(1, end - start);
  const bodyFrac = Math.max(0, Math.min(1, (total - lateWindow - silence) / total));
  const lateFrac = Math.max(0, Math.min(1, lateWindow / total));
  const silenceFrac = Math.max(0, Math.min(1, silence / total));
  // Le curseur sort un peu en dehors de la bande (`-bottom-1`) pour qu'on
  // le voie aussi quand `cursorPercent` tombe pile sur 0 ou 100. La
  // position est bornée dans `[0, 100]`.
  const cursorPercent = Math.max(0, Math.min(100, ((now - start) / total) * 100));
  // Centre de la zone `late` en pourcentage de la barre : la zone
  // commence à `bodyFrac` et s'étend sur `lateFrac`, donc son centre
  // est à `bodyFrac + lateFrac / 2`. Le label « LAST 15% » se cale
  // dessus (avec `-translate-x-1/2` pour le recentrage horizontal).
  const lateCenterPercent = (bodyFrac + lateFrac / 2) * 100;

  return (
    <div
      data-status={status}
      aria-label={`Mandate timeline, status ${STATUS_LABEL[status]}`}
      className={`merion-timeline relative w-full ${className}`}
    >
      <div className="absolute top-0 right-0 z-10">
        <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
      </div>

      <div className="pt-7">
        <div className="relative h-3 w-full">
          {/* Les trois zones — la couleur de fond et l'opacité dépendent
              du statut courant (cf. `app/globals.css`). */}
          <div className="absolute inset-0 flex">
            <div
              className="merion-timeline-zone-body h-full bg-merion-blue rounded-l-full"
              style={{ width: `${bodyFrac * 100}%` }}
              aria-hidden="true"
            />
            <div
              className="merion-timeline-zone-late h-full bg-warning"
              style={{ width: `${lateFrac * 100}%` }}
              aria-hidden="true"
            />
            <div
              className="merion-timeline-zone-silence h-full bg-neutral rounded-r-full"
              style={{ width: `${silenceFrac * 100}%` }}
              aria-hidden="true"
            />
          </div>

          {/* Label de la fenêtre tardive — posé seulement pendant la
              phase `late`, calé sur le centre de la zone warning
              (`lateCenterPercent`, jamais sur 50 % de la barre). */}
          {status === 'late' ? (
            <span
              className="merion-timeline-late-label absolute -top-5 -translate-x-1/2 text-caption uppercase tracking-wide text-warning font-medium"
              style={{ left: `${lateCenterPercent}%` }}
              aria-hidden="true"
            >
              Last 15%
            </span>
          ) : null}

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
