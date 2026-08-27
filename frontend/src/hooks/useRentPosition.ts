import { useReadContracts } from 'wagmi';
import { deployedPool } from '@/constants/addresses';
import { poolAbi } from '@/constants/abi';
import { AUCTION_POLL_MS } from '@/hooks/useAuctionState';

// I.5 — Les huit scalaires du loyer LP pour une adresse, en un multicall. Le
// calcul du montant réclamable vit dans `lib/rentClaimable`, pas ici : ce hook
// ne fait que lire, la fonction pure fait l'arithmétique, et elle reste
// testable sans chaîne.
//
// POURQUOI HUIT LECTURES ET PAS UNE VUE : le Pool n'expose pas de
// `claimable(address)`. `claimRent()` calcule le montant mais l'écrit, et il
// revert `ZeroRentOwed` quand il n'y a rien, donc même une simulation ne
// rendrait rien d'exploitable pour un LP à zéro. Les scalaires sont tous
// publics, le front refait donc le calcul du contrat.
export function useRentPosition(user: `0x${string}` | undefined) {
  const { data, isLoading, error, queryKey } = useReadContracts({
    contracts: [
      { address: deployedPool, abi: poolAbi, functionName: 'accPerShare', args: [] },
      { address: deployedPool, abi: poolAbi, functionName: 'rentRate', args: [] },
      { address: deployedPool, abi: poolAbi, functionName: 'rentEnd', args: [] },
      { address: deployedPool, abi: poolAbi, functionName: 'rentLastUpdate', args: [] },
      { address: deployedPool, abi: poolAbi, functionName: 'totalSupply', args: [] },
      { address: deployedPool, abi: poolAbi, functionName: 'balanceOf', args: [user ?? '0x0000000000000000000000000000000000000000'] },
      { address: deployedPool, abi: poolAbi, functionName: 'rentDebt', args: [user ?? '0x0000000000000000000000000000000000000000'] },
      { address: deployedPool, abi: poolAbi, functionName: 'rentPending', args: [user ?? '0x0000000000000000000000000000000000000000'] }
    ] as const,
    query: {
      // Sans adresse connectée il n'y a pas de position à lire, et les trois
      // dernières lectures viseraient l'adresse nulle : une réponse à zéro qui
      // se lirait comme « rien à réclamer » alors que la vraie réponse est
      // « personne n'est connecté ».
      enabled: user !== undefined,
      refetchInterval: AUCTION_POLL_MS
    }
  });

  return { data, isLoading, error, queryKey };
}
