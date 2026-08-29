import { useConnection } from 'wagmi';
import { isSupportedChain } from '@/constants/addresses';

/**
 * True when a wallet is connected to a chain Merion is not deployed on.
 * False while disconnected — "not connected" and "wrong network" are different
 * states: a disconnected user has no chain to be wrong about, and every write
 * is already gated on `userAddress`.
 *
 * The test is membership in the address table, not equality with one hardcoded
 * ID, so a Hardhat wallet is accepted like Base Sepolia. The write paths that
 * are rendered inside a `wrong-network` boundary (Swap, AddLiquidity,
 * RemoveLiquidity, MrnGrant) use this indirectly; those rendered outside it —
 * the faucet buttons and the auction panel — gate on it directly.
 */
export function useIsWrongNetwork(): boolean {
  const { status, chainId } = useConnection();
  return status === 'connected' && !isSupportedChain(chainId);
}
