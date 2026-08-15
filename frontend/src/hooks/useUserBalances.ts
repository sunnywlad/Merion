import { useConnection, useReadContracts } from 'wagmi';
import {tokensInfo} from '@/constants/addresses';
import {mockWrappedBTCAbi} from '@/constants/abi';

export function useUserBalances() {
  const userAddress = useConnection().address;

  return useReadContracts({
    contracts: tokensInfo.map((token) => {
      return {
        address: token.address,
        abi: mockWrappedBTCAbi,
        functionName: 'balanceOf',
        args: [userAddress!]
      } as const;
    }),
    query: { enabled: Boolean(userAddress) }
  })
}
