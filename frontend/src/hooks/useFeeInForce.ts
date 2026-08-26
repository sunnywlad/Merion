import {deployedPool} from '@/constants/addresses';
import {poolAbi} from '@/constants/abi';
import { useReadContract } from 'wagmi';

// Lit `feeInForce()` et non la variable brute `feeNum` : hors du mandat qui l'a
// posee, la base ecrite retombe au nominal, et seul `feeInForce()` en rend
// compte. C'est aussi ce qui preserve le type, la vue rendant un uint256, donc
// un bigint, la ou `feeNum` est un uint16 que viem decode en number.
export function useFeeInForce() {
  return useReadContract({
    address: deployedPool,
    abi: poolAbi,
    functionName: 'feeInForce',
    args: []
  })
}
