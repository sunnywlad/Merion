import { useReadContracts } from 'wagmi';
import {addresses, tokensInfo} from '@/constants/addresses';
import {poolAbi} from '@/constants/abi';

export function useReserves() {
  const { data, isLoading, error, queryKey } = useReadContracts({
    contracts: [...tokensInfo.map((token) => {
      return {
        address: addresses[31337].pool,
        abi: poolAbi,
        functionName: 'reserves',
        args: [token.index]
      } as const}),
      {
        address: addresses[31337].pool,
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
