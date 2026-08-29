import { useChainId } from "wagmi";
import { getAddressesForChain, DEFAULT_CHAIN_ID, type ChainAddresses } from "@/constants/addresses";

/**
 * V.4 — Returns the deployed addresses for the wallet's currently
 * connected chain, falling back to the default (Base Sepolia) when no
 * wallet is connected or the chain is unsupported.
 *
 * Used everywhere a `deployedPool` / `tokensInfo` / etc. was previously
 * imported as a module-level constant. The hook makes the addresses
 * reactive to wallet switching, so a user toggling between Hardhat
 * (31337) and Base Sepolia (84532) gets the right contract set without
 * a page reload.
 */
export function useAddresses(): ChainAddresses {
  const chainId = useChainId();
  return getAddressesForChain(chainId);
}

/** Convenience : the chainId the addresses are currently for. */
export function useDeployedChainId(): number {
  const chainId = useChainId();
  return chainId ?? DEFAULT_CHAIN_ID;
}
