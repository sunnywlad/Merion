import {deployedPool} from '@/constants/addresses';
import {poolAbi} from '@/constants/abi';
import { useReadContract } from 'wagmi';

export function useFeeNum() {
  return useReadContract({
    address: deployedPool,
    abi: poolAbi,
    functionName: 'feeNum',
    args: []
  })
}
