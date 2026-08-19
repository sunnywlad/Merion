import { useReadContracts } from 'wagmi';
import {deployedPool, tokensInfo} from '@/constants/addresses';
import {poolAbi} from '@/constants/abi';

export function useReserves() {
  const { data, isLoading, error, queryKey } = useReadContracts({
    contracts: [...tokensInfo.map((token) => {
      return {
        address: deployedPool,
        abi: poolAbi,
        functionName: 'reserves',
        args: [token.index]
      } as const}),
      {
        address: deployedPool,
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
