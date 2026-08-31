'use client';

import { useAuctionConstants } from '@/hooks/useAuctionConstants';
import { useChainNow } from '@/hooks/useChainNow';
import { useMandateTimeline } from '@/hooks/useMandateTimeline';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import { MandateTimeline } from '@/components/MandateTimeline';

/**
 * Frise d'enchère isolée, montée juste sous `AuctionSummary` sur la page
 * `/auction`. L'animation de progression du mandat est la première chose
 * visible sous le résumé, avant les panneaux d'enchère et de mandat.
 *
 * Composant « dumb » côté rendu : toute la dérivation temporelle vient des
 * hooks, `MandateTimeline` ne reçoit que des nombres. Rend `null` tant que
 * l'enchère n'est pas déployée ou qu'une des bornes manque.
 */
export default function AuctionProgress() {
  const now = useChainNow();
  const { auction: deployedAuction } = useDeployedChainId();
  const constants = useAuctionConstants();
  const { startTime, endTime, timelineStatus } = useMandateTimeline();

  // Fenêtre d'enchère = `auctionWindow` du contrat. Sans elle, on ne peut
  // pas placer la zone turquoise : on rend `null` plutôt qu'une barre
  // trompeuse.
  const bidWindow =
    constants.auctionWindow !== undefined ? Number(constants.auctionWindow) : undefined;

  if (
    deployedAuction === null ||
    startTime === undefined ||
    endTime === undefined ||
    bidWindow === undefined ||
    now === null
  ) {
    return null;
  }

  return (
    <div className="px-4 py-1">
      <MandateTimeline
        start={Number(startTime)}
        end={Number(endTime)}
        now={Number(now)}
        bidWindow={bidWindow}
        status={timelineStatus}
      />
    </div>
  );
}
