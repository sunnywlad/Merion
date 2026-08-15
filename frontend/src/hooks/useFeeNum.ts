import {addresses} from '@/constants/addresses';
import {poolAbi} from '@/constants/abi';
import { useReadContract } from 'wagmi';

export function useFeeNum() {
  return useReadContract({
    address: addresses[31337].pool,
    abi: poolAbi,
    functionName: 'feeNum',
    args: []
  })
}
