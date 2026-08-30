import { useConnection } from 'wagmi';
import { isSupportedChain } from '@/constants/addresses';

/**
 * Vrai quand un wallet est connecte a une chaine ou Merion n'est pas deploye.
 * Faux si deconnecte : « non connecte » et « mauvais reseau » sont deux etats distincts, et
 * chaque ecriture est deja gardee par `userAddress`.
 *
 * Le test est l'appartenance a la table d'adresses, pas l'egalite avec un ID code en dur : un
 * wallet Hardhat est accepte comme Base Sepolia. Les ecritures rendues dans une frontiere
 * `wrong-network` (Swap, AddLiquidity, RemoveLiquidity, MrnGrant) l'utilisent indirectement ;
 * celles rendues hors frontiere (faucet, panneau d'enchere) la testent directement.
 */
export function useIsWrongNetwork(): boolean {
  const { status, chainId } = useConnection();
  return status === 'connected' && !isSupportedChain(chainId);
}
