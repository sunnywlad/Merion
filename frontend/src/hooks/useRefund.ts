import { useReadContract } from 'wagmi';
import { deployedAuction } from '@/constants/addresses';
import { auctionAbi } from '@/constants/abi';
import { AUCTION_POLL_MS } from '@/hooks/useAuctionState';

// I.6 — Le remboursement crédité et jamais poussé pour une adresse (`refunds`
// est un mapping public de l'Auction). Sur le modèle de `useManagerOf` :
// une seule lecture, par adresse, au même intervalle que le reste du panneau.
export function useRefund(user: `0x${string}` | undefined) {
  return useReadContract({
    address: deployedAuction ?? undefined,
    abi: auctionAbi,
    functionName: 'refunds',
    args: user === undefined ? undefined : [user],
    query: {
      enabled: deployedAuction !== null && user !== undefined,
      refetchInterval: AUCTION_POLL_MS
    }
  });
}
