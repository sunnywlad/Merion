import { useReadContracts } from 'wagmi';
import { deployedAuction, deployedPool } from '@/constants/addresses';
import { auctionAbi, poolAbi } from '@/constants/abi';

// I.5 — Les scalaires qui ne bougent jamais : trois immuables de l'enchère,
// deux constantes de format, et l'horloge du Pool. Un `staleTime` infini, donc
// une seule lecture par session, là où `useAuctionState` relit toutes les
// quinze secondes.
//
// L'HORLOGE VIENT DU POOL, PAS DE L'ENCHÈRE : `genesis` et `epochDuration` sont
// `internal immutable` côté Auction, donc invisibles. Le contrat les lit du Pool
// à la construction précisément pour que les deux horloges ne puissent pas
// dériver, ce qui rend la lecture côté Pool exacte, pas approchée.
export function useAuctionConstants() {
  const { data, isLoading, error } = useReadContracts({
    contracts: [
      { address: deployedAuction ?? undefined, abi: auctionAbi, functionName: 'minOpeningBid', args: [] },
      { address: deployedAuction ?? undefined, abi: auctionAbi, functionName: 'bidSilence', args: [] },
      { address: deployedAuction ?? undefined, abi: auctionAbi, functionName: 'HIGH_BID_BPS', args: [] },
      { address: deployedAuction ?? undefined, abi: auctionAbi, functionName: 'BPS_DEN', args: [] },
      { address: deployedPool, abi: poolAbi, functionName: 'GENESIS', args: [] },
      { address: deployedPool, abi: poolAbi, functionName: 'EPOCH_DURATION', args: [] },
      { address: deployedPool, abi: poolAbi, functionName: 'PRIORITY_WINDOW', args: [] }
    ] as const,
    query: {
      enabled: deployedAuction !== null,
      staleTime: Infinity
    }
  });

  // Déballés ici, contrairement à `useAuctionState` : aucune de ces sept
  // lectures n'a d'échec qui veuille dire quelque chose. Elles réussissent
  // toutes ou la chaîne est injoignable, et l'appelant n'a que faire du statut
  // par entrée. L'échec d'une entrée est donc replié dans une seule erreur.
  const value = (index: number) => {
    const entry = data?.[index];
    return entry?.status === 'success' ? entry.result : undefined;
  };

  return {
    minOpeningBid: value(0),
    bidSilence: value(1),
    highBidBps: value(2),
    bpsDen: value(3),
    genesis: value(4),
    epochDuration: value(5),
    priorityWindow: value(6),
    isLoading,
    error: error ?? data?.find((entry) => entry.status === 'failure')?.error
  };
}
