import { useReadContracts } from 'wagmi';
import { useAddresses } from '@/hooks/useAddresses';
import {poolAbi} from '@/constants/abi';

export function useReserves() {
  const { pool, tokens } = useAddresses();
  const { data, isLoading, error, queryKey } = useReadContracts({
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
    queryKey
  }
}
