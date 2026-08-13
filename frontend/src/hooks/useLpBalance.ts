import {addresses} from '@/constants/addresses';
import {poolAbi} from '@/constants/abi';
import { useReadContract, useConnection } from 'wagmi';

export function useLpBalance() {
  const address = useConnection().address;
  return useReadContract({
    address: addresses[31337].pool,
    abi: poolAbi,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: Boolean(address)}
  })
}
