import { useReadContracts } from 'wagmi';
import {addresses, tokensInfo} from '@/constants/addresses';
import {poolAbi} from '@/constants/abi';

export function useReserves() {
  return useReadContracts({
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
}
