'use client';

import { useAuctionState } from '@/hooks/useAuctionState';
import { useAuctionConstants } from '@/hooks/useAuctionConstants';
import { useChainNow } from '@/hooks/useChainNow';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import { secondsLeft, formatCountdown } from '@/lib/readMandateWindow';
import { Badge } from '@/components/ui/Badge';

/**
 * Merion `NextAuctionSummary` — jumeau d'`AuctionSummary`, mais pour
 * l'enchère du mandat suivant plutôt que pour l'epoch en cours.
 *
 * La fenêtre d'enchère du mandat `E` court sur les `auctionWindow`
 * premières secondes de l'epoch `E - 1` (doc `Auction.auctionWindow`).
 * Donc :
 *   - tant qu'elle est ouverte, le mandat en vente est `currentEpoch + 1`,
 *     et le décompte vise sa clôture (« Closes in ») ;
 *   - une fois fermée, la prochaine enchère ouvrable est celle de
 *     `currentEpoch + 2`, qui ouvre au basculement d'epoch suivant
 *     (« Opens in », vers `startOfEpoch(currentEpoch + 1)`).
 *
 * `windowOpen()` du contrat rend `false` avant la toute première mise d'un
 * cycle (`sellingEpoch != currentEpoch()+1`) : on rétablit ce cas ici avec
 * `firstBidWindowOpen`, la même dérivation que dans `AuctionPanel`.
 */
export function NextAuctionSummary() {
  const now = useChainNow();
  const auctionDeployed = useDeployedChainId().auction !== null;
  const auction = useAuctionState();
  const constants = useAuctionConstants();

  const currentEpoch =
    auction.currentEpoch?.status === 'success' ? auction.currentEpoch.result : undefined;
  const sellingEpoch =
    auction.sellingEpoch?.status === 'success' ? auction.sellingEpoch.result : undefined;
  const windowOpen =
    auction.windowOpen?.status === 'success' ? auction.windowOpen.result : undefined;
  const closesAt =
    auction.closesAt?.status === 'success' ? auction.closesAt.result : undefined;

  const { genesis, epochDuration, auctionWindow } = constants;
  const clocksReady =
    currentEpoch !== undefined &&
    genesis !== undefined &&
    epochDuration !== undefined &&
    auctionWindow !== undefined;

  // Fin de la fenêtre pour la première mise du cycle : `auctionWindow`
  // premières secondes de l'epoch courante.
  const firstBidClosesAt = clocksReady
    ? genesis + currentEpoch * epochDuration + auctionWindow
    : undefined;
  const firstBidWindowOpen =
    clocksReady &&
    now !== null &&
    sellingEpoch !== undefined &&
    sellingEpoch !== currentEpoch + 1n &&
    now < firstBidClosesAt!;

  const isOpen = windowOpen === true || firstBidWindowOpen;

  const nextEpochStart = clocksReady
    ? genesis + (currentEpoch + 1n) * epochDuration
    : undefined;
  const target = isOpen
    ? (windowOpen === true ? closesAt : firstBidClosesAt)
    : nextEpochStart;
  const countdown =
    now !== null ? secondsLeft(target ?? null, now) : null;

  // Enchère ouverte : on vend `currentEpoch + 1`. Fermée : la prochaine
  // enchère ouvrable vend `currentEpoch + 2`.
  const saleMandate =
    currentEpoch !== undefined
      ? currentEpoch + (isOpen ? 1n : 2n)
      : undefined;
  const indexLabel = saleMandate !== undefined ? `#${String(saleMandate)}` : '#—';
  const countdownLabel = isOpen ? 'Closes in' : 'Opens in';

  return (
    <div className="bg-slate border border-cloud/10 rounded-lg overflow-hidden">
      <div className="flex w-full items-center justify-between gap-6 px-4 py-2 text-left">
        <div className="flex items-center gap-4 min-w-0">
          <span className="text-h4 font-medium text-cloud">Next auction</span>
          <span className="text-body font-medium text-cloud/80 num-tabular">
            {indexLabel}
          </span>
          {!auctionDeployed ? (
            <Badge variant="deprecated">No auction</Badge>
          ) : (
            <Badge variant={isOpen ? 'active' : 'deprecated'}>
              {isOpen ? 'Open' : 'Closed'}
            </Badge>
          )}
        </div>
        <div className="flex items-baseline gap-3">
          <span className="text-caption uppercase tracking-wide text-cloud/60">
            {countdownLabel}
          </span>
          <span className="font-mono text-code text-cloud num-tabular">
            {countdown !== null ? formatCountdown(countdown) : '—'}
          </span>
        </div>
      </div>
    </div>
  );
}

export default NextAuctionSummary;
