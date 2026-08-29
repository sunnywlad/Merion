import { useReadContract } from 'wagmi';
import { useAddresses } from '@/hooks/useAddresses';
import { poolAbi } from '@/constants/abi';
import { AUCTION_POLL_MS } from '@/hooks/useAuctionState';

// I.5 — Le gestionnaire nommé pour un mandat donné, lu sur le Pool.
//
// LE PIÈGE, ET C'EST LE CŒUR DU PANNEAU : pendant toute la durée de l'enchère,
// `managerOf[sellingEpoch]` vaut l'adresse nulle. La nomination n'a lieu qu'au
// `settle()`, pendant la fenêtre de silence. Un panneau qui lirait `managerOf`
// pour annoncer le meneur afficherait donc « personne » alors qu'une enchère
// bat son plein. Le meneur courant se lit sur `auction.highBidder()`, le
// gestionnaire nommé sur `pool.managerOf(epoch)`, et les deux ne disent pas la
// même chose. Le composant tient cet arbitrage explicitement.
//
// L'adresse nulle n'est pas une erreur de lecture : aux constantes livrées un
// mandat vaut quelques dollars, donc un mandat invendu est la prédiction
// honnête, et le pool tourne alors au tarif nominal.
export function useManagerOf(epoch: bigint | undefined) {
  const { pool } = useAddresses();
  return useReadContract({
    address: pool,
    abi: poolAbi,
    functionName: 'managerOf',
    args: epoch === undefined ? undefined : [epoch],
    query: {
      enabled: epoch !== undefined,
      refetchInterval: AUCTION_POLL_MS
    }
  });
}
