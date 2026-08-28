import { Badge } from '@/components/ui/Badge';

export type MandateTimelineStatus = 'new' | 'active' | 'late' | 'closed';

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
 * Merion mandate timeline — horizontal band that visualises the current
 * mandate at scale. Three contiguous zones (body / late window / silence),
 * a present cursor overlaid on the band, and a Badge for the time status.
 *
 * The component is dumb about contract state: the caller reads start/end/now
 * (typically from `genesis`, `epochDuration`, `currentEpoch`, `useChainNow`)
 * and computes `lateWindow`, `silence`, and `status` before passing them in.
 * No hooks live here.
 *
 * Mandate without a manager is the nominal case and is NOT represented by a
 * status here — the absence of a manager is shown by the parent panel's
 * inline line. This component only encodes TIME on the mandate.
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
  const cursorPercent = Math.max(0, Math.min(100, ((now - start) / total) * 100));

  return (
    <div className={`relative w-full ${className}`}>
      <div className="absolute top-0 right-0 z-10">
        <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
      </div>

      <div className="pt-7">
        <div
          className="relative h-3 w-full"
          role="img"
          aria-label={`Mandate timeline, status ${STATUS_LABEL[status]}`}
        >
          <div className="absolute inset-0 flex">
            <div
              className="h-full bg-merion-blue rounded-l-full"
              style={{ width: `${bodyFrac * 100}%` }}
            />
            <div
              className="h-full bg-warning"
              style={{ width: `${lateFrac * 100}%` }}
            />
            <div
              className="h-full bg-neutral rounded-r-full"
              style={{ width: `${silenceFrac * 100}%` }}
            />
          </div>
          <div
            className="absolute top-0 -bottom-1 w-0.5 bg-cloud -translate-x-1/2 pointer-events-none"
            style={{ left: `${cursorPercent}%` }}
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}

export default MandateTimeline;
