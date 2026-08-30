import { useChainId, useReadContracts } from 'wagmi'
import type {
  UseReadContractsParameters,
  UseReadContractsReturnType,
} from 'wagmi'
import { hardhat } from '@reown/appkit/networks'

// Hardhat n'a pas Multicall3 déployé à l'adresse canonique sur 31337.
// Sur cette chaîne uniquement, on bascule viem en mode deployless
// (eth_call + bytecode Multicall3 inline, aucun contrat on-chain requis).
// Base Sepolia garde son Multicall3 natif : `deployless` reste undefined
// (=> false) et les RPC publics ne reçoivent jamais d'eth_call avec code.
export function useMerionReadContracts<
  const contracts extends readonly unknown[],
  allowFailure extends boolean = true,
>(
  parameters?: UseReadContractsParameters<contracts, allowFailure>
): UseReadContractsReturnType<contracts, allowFailure> {
  const chainId = useChainId()
  return useReadContracts({
    ...parameters,
    deployless: chainId === hardhat.id ? true : undefined,
  } as UseReadContractsParameters<contracts, allowFailure>)
}
