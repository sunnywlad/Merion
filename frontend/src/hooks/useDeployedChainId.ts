import { useChainId } from "wagmi";
import { getAddressesForChain, type ChainAddresses } from "@/constants/addresses";

/**
 * V.4 — Rend les adresses deployees pour la chaine connectee au wallet, avec repli sur la
 * chaine par defaut (Base Sepolia) si aucun wallet n'est connecte ou si la chaine n'est pas
 * supportee. Type de retour `ChainAddresses` : les appelants destructurent `{ auction, pool,
 * tokens, mrn }`.
 */
export function useDeployedChainId(): ChainAddresses {
  const chainId = useChainId();
  return getAddressesForChain(chainId);
}