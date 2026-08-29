import { useReadContracts } from 'wagmi';
import { useAddresses } from '@/hooks/useAddresses';
import {poolAbi} from '@/constants/abi';

export function useConstants() {
  const { pool } = useAddresses();
  const { data, isLoading, error } = useReadContracts({
    contracts: [{
        address: pool,
        abi: poolAbi,
        functionName: 'FEE_DEN',
        args: []
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'MAX_FEE_NUM',
        args: []
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'MIN_FEE_NUM',
        args: []
      }
    ] as const,
    query: { staleTime: Infinity }
  })
  return {
    feeDen: data?.[0],
    maxFeeNum: data?.[1],
    minFeeNum: data?.[2],
    isLoading,
    error
  }
}
