import {deployedPool} from '@/constants/addresses';
import {poolAbi} from '@/constants/abi';
import { useReadContract, useConnection } from 'wagmi';

export function useLpBalance() {
  const address = useConnection().address;
  return useReadContract({
    address: deployedPool,
    abi: poolAbi,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: Boolean(address)}
  })
}
