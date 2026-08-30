import { useChainId } from "wagmi";
import { getAddressesForChain, type ChainAddresses } from "@/constants/addresses";

/**
 * V.4 — Returns the deployed addresses for the wallet's currently
 * connected chain, falling back to the default (Base Sepolia) when no
 * wallet is connected or the chain is unsupported.
 *
 * Same body as `useAddresses` : the rename to `useDeployedChainId`
 * marks the intent (resolve addresses by deployed chain) and prepares
 * the deletion of `useAddresses` in a later step. The return type stays
 * `ChainAddresses`, so callers destructure `{ auction, pool, tokens,
 * mrn }` exactly as before.
 */
export function useDeployedChainId(): ChainAddresses {
  const chainId = useChainId();
  return getAddressesForChain(chainId);
}