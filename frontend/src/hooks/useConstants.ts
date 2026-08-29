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
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'floor',
        args: []
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'ceiling',
        args: []
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'NOMINAL_FEE_NUM',
        args: []
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'PROTOCOL_FEE_BPS',
        args: []
      },
      {
        address: pool,
        abi: poolAbi,
        functionName: 'SPLIT_DEN',
        args: []
      }
    ] as const,
    query: { staleTime: Infinity }
  })
  return {
    feeDen: data?.[0],
    maxFeeNum: data?.[1],
    minFeeNum: data?.[2],
    /**
     * Reserve bands, as percentages of the post-swap sum. Both are `constant`
     * in `Pool.sol` with no setter — the corridor is roadmap, the values are
     * not — so `staleTime: Infinity` reads them exactly once per session.
     * They ride in this multicall because Swap already pays for it: a
     * separate hook would have meant a second round-trip for two uint8s.
     */
    floorBps: data?.[3],
    ceilingBps: data?.[4],
    /**
     * Fee split, needed to reproduce how much of an input actually reaches the
     * reserves — `Pool.swap` books the cuts to pull-only registries instead.
     * `NOMINAL_FEE_NUM` is `immutable` (constructor) and the other two are
     * `constant`, so they belong here with the other read-once values.
     */
    nominalFeeNum: data?.[5],
    protocolFeeBps: data?.[6],
    splitDen: data?.[7],
    isLoading,
    error
  }
}
