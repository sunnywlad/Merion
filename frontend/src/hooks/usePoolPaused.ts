import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import { poolAbi } from '@/constants/abi';
import { MANDATE_POLL_MS } from '@/hooks/_constants';
import { useReadContract } from 'wagmi';

// Le flag `paused` du pool. L'owner met en pause les swaps et les depots, rien d'autre
// (C4 : il ne peut toucher ni la fee, ni les reserves, ni une bande). Un pool en pause rejette
// donc tout swap, addLiquidity et removeLiquidity que le front peut construire.
//
// Polle plutot que lu une fois : la mise en pause est un acte operationnel qui arrive page
// ouverte ; sans polling, un utilisateur ayant charge le formulaire avant signerait vers un revert.
//
// La lecture ne depend pas d'un wallet connecte (lecture publique) : les formulaires affichent
// l'etat pause meme deconnectes.
export function usePoolPaused() {
  const { pool } = useDeployedChainId();
  return useReadContract({
    address: pool,
    abi: poolAbi,
    functionName: 'paused',
    args: [],
    query: { refetchInterval: MANDATE_POLL_MS }
  });
}
