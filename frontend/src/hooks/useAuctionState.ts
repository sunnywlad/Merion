import { useReadContracts } from 'wagmi';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import { auctionAbi } from '@/constants/abi';
import { AUCTION_POLL_MS } from '@/hooks/_constants';

// I.5 — L'état vivant de l'enchère, en un seul multicall. Ce qui bouge est ici,
// ce qui ne bouge jamais est dans `useAuctionConstants` : c'est la séparation
// qui permet de relire ce hook à intervalle lâche sans relire des immuables.
//
// L'INTERVALLE : 15 secondes, quand le décompte affiché tique à la seconde.
// Le décompte est local, dérivé de `closesAt()`, et il ne ment que d'une
// seconde ; relire la chaîne à chaque tick serait quinze fois le trafic RPC
// pour la même information. La constante vit dans `_constants.ts` (R3/B.4)
// pour qu'un hook applicatif ne serve plus de module de constantes.

export function useAuctionState() {
  const { auction } = useDeployedChainId();
  const { data, isLoading, error, queryKey } = useReadContracts({
    contracts: [
      { address: auction ?? undefined, abi: auctionAbi, functionName: 'currentEpoch', args: [] },
      { address: auction ?? undefined, abi: auctionAbi, functionName: 'sellingEpoch', args: [] },
      { address: auction ?? undefined, abi: auctionAbi, functionName: 'currentBid', args: [] },
      { address: auction ?? undefined, abi: auctionAbi, functionName: 'highBidder', args: [] },
      { address: auction ?? undefined, abi: auctionAbi, functionName: 'windowOpen', args: [] },
      // `closesAt()` REVERT tant qu'aucune mise n'a jamais été posée : il calcule
      // `startOfEpoch(sellingEpoch - 1)`, et la soustraction sous-déborde à
      // `sellingEpoch == 0`. Cette entrée en échec est donc un état nominal, et
      // le panneau la lit comme telle au lieu de la router vers `ReadErrors`.
      { address: auction ?? undefined, abi: auctionAbi, functionName: 'closesAt', args: [] },
      // I.6 — Le mandat gagné mais pas encore réglé. Les deux valent zéro
      // ensemble quand le slot est vide (`settle()` viendrait de reverter
      // `NoBidToSettle`) : c'est un état nominal, pas une erreur de lecture.
      { address: auction ?? undefined, abi: auctionAbi, functionName: 'pendingEpoch', args: [] },
      { address: auction ?? undefined, abi: auctionAbi, functionName: 'pendingAmount', args: [] }
    ] as const,
    query: {
      enabled: auction !== null,
      refetchInterval: AUCTION_POLL_MS
    }
  });

  return {
    currentEpoch: data?.[0],
    sellingEpoch: data?.[1],
    currentBid: data?.[2],
    highBidder: data?.[3],
    windowOpen: data?.[4],
    closesAt: data?.[5],
    pendingEpoch: data?.[6],
    pendingAmount: data?.[7],
    isLoading,
    error,
    queryKey
  };
}
