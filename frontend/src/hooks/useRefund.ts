import { useReadContract } from 'wagmi';
import { useAddresses } from '@/hooks/useAddresses';
import { auctionAbi } from '@/constants/abi';
import { MANDATE_POLL_MS } from '@/hooks/_constants';

// I.6 — Le remboursement crédité et jamais poussé pour une adresse (`refunds`
// est un mapping public de l'Auction). Sur le modèle de `useManagerOf` :
// une seule lecture, par adresse, au même intervalle que le reste du panneau.
export function useRefund(user: `0x${string}` | undefined) {
  const { auction } = useAddresses();
  return useReadContract({
    address: auction ?? undefined,
    abi: auctionAbi,
    functionName: 'refunds',
    args: user === undefined ? undefined : [user],
    query: {
      enabled: auction !== null && user !== undefined,
      refetchInterval: MANDATE_POLL_MS
    }
  });
}
