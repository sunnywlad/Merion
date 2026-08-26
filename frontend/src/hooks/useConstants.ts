import { useReadContracts } from 'wagmi';
import {deployedPool} from '@/constants/addresses';
import {poolAbi} from '@/constants/abi';

export function useConstants() {
  const { data, isLoading, error } = useReadContracts({
    contracts: [{
        address: deployedPool,
        abi: poolAbi,
        functionName: 'FEE_DEN',
        args: []
      },
      {
        address: deployedPool,
        abi: poolAbi,
        functionName: 'MAX_FEE_NUM',
        args: []
      }
    ] as const,
    query: { staleTime: Infinity }
  })
  return {
    feeDen: data?.[0],
    maxFeeNum: data?.[1],
    isLoading,
    error
  }
}
