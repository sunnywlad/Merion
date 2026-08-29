import { useAddresses } from '@/hooks/useAddresses';
import {poolAbi} from '@/constants/abi';
import { useReadContract, useConnection } from 'wagmi';

export function useLpBalance() {
  const { pool } = useAddresses();
  const address = useConnection().address;
  // V.4/bug-race — `refetch` est exposé pour qu'AddLiquidity et
  // RemoveLiquidity puissent re-lire le solde LP APRÈS settle, sans
  // tirer toutes les autres queries via `refetchQueries()` global.
  return useReadContract({
    address: pool,
    abi: poolAbi,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: Boolean(address)}
  })
}
// Le hook retourne directement le résultat de useReadContract, qui inclut
// déjà `refetch` en plus de `data` / `isLoading` / `error`. Pas de
// wrapping nécessaire — les consumers (Balances, AddLiquidity,
// RemoveLiquidity) font `const { data, refetch } = useLpBalance()`.
