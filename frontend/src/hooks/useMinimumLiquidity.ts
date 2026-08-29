import { useAddresses } from '@/hooks/useAddresses';
import {poolAbi} from '@/constants/abi';
import { useReadContract } from 'wagmi';

export function useMinimumLiquidity(enabled: boolean) {
  const { pool } = useAddresses();
  return useReadContract({
    address: pool,
    abi: poolAbi,
    functionName: 'MINIMUM_LIQUIDITY',
    args: [],
    query: { enabled, staleTime: Infinity }
  })
}
