import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import {poolAbi} from '@/constants/abi';
import { useReadContract } from 'wagmi';

// MINIMUM_LIQUIDITY du Pool : parts LP brulees au bootstrap. Constante, lue une seule fois.
export function useMinimumLiquidity(enabled: boolean) {
  const { pool } = useDeployedChainId();
  return useReadContract({
    address: pool,
    abi: poolAbi,
    functionName: 'MINIMUM_LIQUIDITY',
    args: [],
    query: { enabled, staleTime: Infinity }
  })
}
