import { useReadContracts } from 'wagmi';
import { useAddresses } from '@/hooks/useAddresses';
import {poolAbi} from '@/constants/abi';

export function useReserves() {
  const { pool, tokens } = useAddresses();
  const { data, isLoading, error, refetch, queryKey } = useReadContracts({
    contracts: [...tokens.map((token) => {
      return {
        address: pool,
        abi: poolAbi,
        functionName: 'reserves',
        args: [token.index]
      } as const}),
      {
        address: pool,
        abi: poolAbi,
        functionName: 'totalSupply',
        args: []
      }
    ] as const,
  })
  return {
    reserves: data?.slice(0, 3),
    supply: data?.[3],
    isLoading,
    error,
    // V.4/bug-race — refetch exposé pour que les flows multi-tx (Swap,
    // AddLiquidity, RemoveLiquidity) puissent forcer un re-read ciblé
    // des réserves APRÈS settle, au lieu de `refetchQueries()` global.
    refetch,
    queryKey
  }
}
