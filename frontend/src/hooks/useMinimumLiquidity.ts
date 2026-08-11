import {addresses} from '@/constants/addresses';
import {poolAbi} from '@/constants/abi';
import { useReadContract } from 'wagmi';

export function useMinimumLiquidity(enabled: boolean) {
  return useReadContract({
    address: addresses[31337].pool,
    abi: poolAbi,
    functionName: 'MINIMUM_LIQUIDITY',
    args: [],
    query: { enabled, staleTime: Infinity }
  })
}
