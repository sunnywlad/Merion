import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import { MANDATE_POLL_MS } from '@/hooks/_constants';

// I.4 — Vue on-chain `claimable(address)` du Pool (Pool.sol:985). Le
// commentaire de tête à Pool.sol:977-981 l'annonçait comme la source
// front du loyer réclamable : un seul `useReadContract` la lit.
//
// Fragment ABI local : la vue existe sur le contrat depuis I.4 mais
// `constants/abi.ts` (sortie Hardhat) n'a pas été régénéré. Le mini-
// fragment `as const` laisse wagmi inférer `data: bigint | undefined`
// sans toucher à l'ABI global ; un regen futur pourra basculer ce
// hook sur `poolAbi` sans changer son API.
const claimableAbi = [
  {
    type: 'function',
    name: 'claimable',
    stateMutability: 'view',
    inputs: [{ name: '_who', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export function useClaimableRent(user: Address | undefined) {
  const { pool } = useDeployedChainId();
  return useReadContract({
    address: pool,
    abi: claimableAbi,
    functionName: 'claimable',
    args: user === undefined ? undefined : [user],
    query: {
      enabled: user !== undefined,
      refetchInterval: MANDATE_POLL_MS
    }
  });
}
