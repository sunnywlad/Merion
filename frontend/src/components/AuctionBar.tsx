'use client';

import { useEffectiveFees } from '@/hooks/useEffectiveFees';
import { useConstants } from '@/hooks/useConstants';
import { useChainNow } from '@/hooks/useChainNow';
import { useMandateTimeline } from '@/hooks/useMandateTimeline';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import { secondsLeft, formatCountdown } from '@/lib/readMandateWindow';
import AuctionPanel from '@/components/AuctionPanel';
import MandatePanel from '@/components/MandatePanel';
import Chevron from '@/components/ui/Chevron';
import Disclosure from '@/components/ui/Disclosure';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';

/**
 * Merion AuctionBar.
 *
 * Barre d'enchère permanente au-dessus du pli, sur les trois routes
 * applicatives. C'est le différenciateur du produit : sa présence
 * constante signale que Merion n'est ni un swap pur ni un lend pur.
 *
 * Toujours visible, même replié. La barre résumée montre
 * en permanence :
 *   - l'index du mandat (gauche),
 *   - le statut (`ACTIVE`, `NEXT MANDATE`, `LATE WINDOW`, `CLOSED`),
 *   - le frais de base en vigueur,
 *   - le temps restant.
 *
 * Jamais un simple lien « Show details » sans contenu. Le dépliage
 * montre le panneau d'enchère (saisie d'enchère, refund, settle, setFee)
 * et le détail du mandat (timeline, surcharge, loyer à réclamer) ; le
 * mandat quitte le rail.
 */
export default function AuctionBar() {
  const fees = useEffectiveFees();
  const poolConstants = useConstants();
  const now = useChainNow();
  const {
    currentEpoch,
    endTime,
    timelineStatus,
  } = useMandateTimeline();

  const STATUS_VARIANT: Record<typeof timelineStatus, BadgeVariant> = {
    new: 'new',
    active: 'active',
    late: 'beta',
    closed: 'deprecated',
  };
  const STATUS_LABEL: Record<typeof timelineStatus, string> = {
    new: 'New',
    active: 'Active',
    late: 'Late window',
    closed: 'Closed',
  };

  const timeToEnd =
    now !== null && endTime !== undefined
      ? secondsLeft(endTime, now)
      : null;

  // — Frais de base en vigueur, format français.
  const feeDenEntry = poolConstants.feeDen;
  const feeDen =
    feeDenEntry?.status === 'success' ? feeDenEntry.result : undefined;
  const basePercent =
    fees.base !== undefined && feeDen
      ? Number((fees.base * 10000n) / feeDen) / 100
      : undefined;
  // Pourcentages en mono : `%` collé sans espace (« à l'intérieur
  // du nombre mono »). On convertit avec `.replace('.', ',')` pour le
  // séparateur décimal français ; grouping milliers non pertinent sur
  // ces valeurs (jamais au-delà de 99,99 %).
  const baseLabel =
    basePercent !== undefined
      ? `${basePercent.toFixed(2).replace('.', ',')}%`
      : '—';

  // — Index + libellé « Mandate #N » ou « — » si pas chargé.
  const indexLabel =
    currentEpoch !== undefined ? `Epoch #${String(currentEpoch)}` : 'Epoch —';
  const timeLabel =
    timeToEnd !== null ? formatCountdown(timeToEnd) : '—';

  const auctionDeployed = useDeployedChainId().auction !== null;

  return (
    <div className="bg-slate border border-cloud/10 rounded-lg overflow-hidden">
      <Disclosure
        id="auction-bar-panel"
        defaultOpen={false}
        trigger={(open, toggle) => (
          <button
            type="button"
            aria-expanded={open}
            aria-controls="disclosure-auction-bar-panel"
            onClick={toggle}
            className={
              `group flex w-full items-center justify-between gap-6 px-4 py-2 text-left ` +
              `transition-colors duration-150 ` +
              `hover:bg-cloud/5 ` +
              `focus:outline-none focus-visible:border-merion-blue focus-visible:border-2`
            }
          >
            <div className="flex items-center gap-4 min-w-0">
              <span className="text-h4 font-medium text-cloud">Epoch</span>
              <span className="text-caption uppercase tracking-wide text-cloud/60 num-tabular">
                {indexLabel}
              </span>
              {!auctionDeployed ? (
                <Badge variant="deprecated">No auction</Badge>
              ) : (
                <Badge variant={STATUS_VARIANT[timelineStatus]}>
                  {STATUS_LABEL[timelineStatus]}
                </Badge>
              )}
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
              <Chevron open={open} label={open ? 'Hide details' : 'Show details'} />
            </div>
          </button>
        )}
      >
        <div className="border-t border-cloud/10 px-4 py-4 flex flex-col gap-6">
          <AuctionPanel />
          {auctionDeployed ? <MandatePanel /> : null}
        </div>
      </Disclosure>
    </div>
  );
}
