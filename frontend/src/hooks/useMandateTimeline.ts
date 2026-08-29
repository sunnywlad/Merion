import { useAuctionState } from '@/hooks/useAuctionState';
import { useAuctionConstants } from '@/hooks/useAuctionConstants';
import { useChainNow } from '@/hooks/useChainNow';
import {
  computeMandateStatus,
  computeLateWindow,
  type MandateTimelineStatus,
} from '@/components/_mandateStatus';

// I.5/B.1 — Timeline du mandat courant, partagée entre `AuctionBar`
// (résumé dépliable) et `MandatePanel` (détail). Avant cette tâche, les
// deux calculaient la même chaîne `currentEpoch → startTime → endTime →
// totalDuration → lateWindow → timelineStatus` inline, avec un commentaire
// qui justifiait la duplication par « souci de clarté ». C'est l'inverse
// : la duplication est un risque de drift, pas un gain de lisibilité.
//
// Le préfixe `use*` suit la convention wagmi (hook applicatif). La
// consommation des 3 hooks `useAuctionState` / `useAuctionConstants` /
// `useChainNow` est dédupliquée par wagmi sur le `queryKey`, donc la
// fréquence de relecture ne change pas par rapport à l'inline.
export function useMandateTimeline() {
  const auction = useAuctionState();
  const constants = useAuctionConstants();
  const now = useChainNow();

  const currentEpoch =
    auction.currentEpoch?.status === 'success'
      ? auction.currentEpoch.result
      : undefined;
  const startTime =
    currentEpoch !== undefined &&
    constants.genesis !== undefined &&
    constants.epochDuration !== undefined
      ? constants.genesis + currentEpoch * constants.epochDuration
      : undefined;
  const endTime =
    currentEpoch !== undefined &&
    constants.genesis !== undefined &&
    constants.epochDuration !== undefined
      ? constants.genesis + (currentEpoch + 1n) * constants.epochDuration
      : undefined;
  const totalDuration =
    startTime !== undefined && endTime !== undefined
      ? Number(endTime - startTime)
      : undefined;
  const lateWindow = computeLateWindow(totalDuration);
  // Source unique du `timelineStatus` (note §11, tâche 5) — la
  // formule est partagée via `_mandateStatus.ts`.
  const timelineStatus: MandateTimelineStatus = computeMandateStatus({
    now,
    start: startTime,
    end: endTime,
    lateWindow,
  });

  return {
    currentEpoch,
    startTime,
    endTime,
    totalDuration,
    lateWindow,
    timelineStatus,
  };
}
