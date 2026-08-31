'use client';

import { useEffectiveFees } from '@/hooks/useEffectiveFees';
import { useConstants } from '@/hooks/useConstants';
import { useChainNow } from '@/hooks/useChainNow';
import { useMandateTimeline } from '@/hooks/useMandateTimeline';
import { secondsLeft, formatCountdown } from '@/lib/readMandateWindow';

/**
 * Merion `AuctionSummary` — entête de la page `/auction`.
 *
 * La barre résumée reste affichée en tête de page, et les panneaux
 * `AuctionPanel` + `MandatePanel` sont montés en pleine lecture juste en
 * dessous.
 *
 * Contenu : index du mandat, statut, frais de base, temps restant.
 */
export function AuctionSummary() {
  const fees = useEffectiveFees();
  const poolConstants = useConstants();
  const now = useChainNow();
  const { currentEpoch, endTime } = useMandateTimeline();

  const timeToEnd =
    now !== null && endTime !== undefined
      ? secondsLeft(endTime, now)
      : null;

  const feeDenEntry = poolConstants.feeDen;
  const feeDen =
    feeDenEntry?.status === 'success' ? feeDenEntry.result : undefined;
  const basePercent =
    fees.base !== undefined && feeDen
      ? Number((fees.base * 10000n) / feeDen) / 100
      : undefined;
  const baseLabel =
    basePercent !== undefined
      ? `${basePercent.toFixed(2).replace('.', ',')}%`
      : '—';

  const indexLabel =
    currentEpoch !== undefined ? `#${String(currentEpoch)}` : '#—';
  const timeLabel =
    timeToEnd !== null ? formatCountdown(timeToEnd) : '—';

  return (
    <div className="bg-slate border border-cloud/10 rounded-lg overflow-hidden">
      <div
        className={
          `group flex w-full items-center justify-between gap-6 px-4 py-2 text-left ` +
          `transition-colors duration-150`
        }
      >
        <div className="flex items-center gap-4 min-w-0">
          <span className="text-h4 font-medium text-cloud">Epoch</span>
          <span className="text-body font-medium text-cloud/80 num-tabular">
            {indexLabel}
          </span>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-baseline gap-3">
            <span className="text-caption uppercase tracking-wide text-cloud/60">
              Base fee
            </span>
            <span className="font-mono text-code text-cloud num-tabular">
              {baseLabel}
            </span>
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-caption uppercase tracking-wide text-cloud/60">
              Ends in
            </span>
            <span className="font-mono text-code text-cloud num-tabular">
              {timeLabel}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AuctionSummary;
