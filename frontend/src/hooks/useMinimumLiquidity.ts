import {deployedPool} from '@/constants/addresses';
import {poolAbi} from '@/constants/abi';
import { useReadContract } from 'wagmi';

export function useMinimumLiquidity(enabled: boolean) {
  return useReadContract({
    address: deployedPool,
    abi: poolAbi,
    functionName: 'MINIMUM_LIQUIDITY',
    args: [],
    query: { enabled, staleTime: Infinity }
  })
}
