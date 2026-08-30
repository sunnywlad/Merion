import { useMemo } from 'react';
import { useConnection, useReadContracts } from 'wagmi';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import {auctionAbi, mrnAbi, mockWrappedBTCAbi} from '@/constants/abi';

// Toutes les balances utilisateur dans un seul multicall : trois BTCs + MRN +
// le refund MRN a retirer (mapping Auction.refunds). Le hook rend des
// CHAMPS NOMNES, jamais le tableau positionnel de useReadContracts : un
// `data?.[4]` est un nombre magique qui casse en silence a la premiere
// insertion d'une nouvelle lecture (cf. web3-libs-seen, "no magic numbers").
//
// L'ordre des indices dans le multicall est fige (BTC0..2, MRN, refund),
// mais chaque consommateur lit un champ nomme, jamais un index. Les
// nouvelles lectures (MRN + refund) sont ajoutees en queue, sans rien
// deplacer : le bloc BTCs garde ses indices 0..2 et les anciens appels
// (Swap, Balances) tiennent par construction apres mise a jour du
// consommateur.
//
// CAST A LA FRONTIERE, pas au site d'appel : wagmi 3 perd la precision par
// entree quand un multicall melange des ABIs (mockWrappedBTCAbi, mrnAbi,
// auctionAbi) — chaque `result` elargit en `unknown` au site d'extraction.
// Tous nos retours sont pourtant `uint256` (`bigint` runtime), donc on
// restaure le type ici, une seule fois, sous la forme `ReadEntry`, et les
// consommateurs (Balances, Swap) restent types strict sans cast local.
// C'est la limite honnete du typage wagmi 3 sur les multicalls heterogenes.
// Le type reproduit `ContractResult` sans le discriminer, parce que nos
// consommateurs lisent `.result` ET `.error` sur la meme entree ; seul
// `status: 'success' | 'failure'` reste discriminant, `result` et `error`
// sont tous deux optionnels.
type ReadEntry = { status: 'success' | 'failure'; result?: bigint; error?: Error };

export function useUserBalances() {
  const userAddress = useConnection().address;
  const { tokens, mrn, auction } = useDeployedChainId();

  const { data, isLoading, error, refetch } = useReadContracts({
    contracts: [
      ...tokens.map((token) => ({
        address: token.address,
        abi: mockWrappedBTCAbi,
        functionName: 'balanceOf',
        args: [userAddress!]
      })),
      {
        address: mrn,
        abi: mrnAbi,
        functionName: 'balanceOf',
        args: [userAddress!]
      },
      {
        address: auction ?? undefined,
        abi: auctionAbi,
        functionName: 'refunds',
        args: [userAddress!]
      }
    ] as const,
    // lisse les allers-retours onglet, plan §6 RPC
    query: { enabled: Boolean(userAddress), staleTime: 5_000 }
  });

  // Perf E — `useMemo([data])` : sans ça, `btcBalances` est un nouveau
  // tableau à chaque rendu (même contenu, identité différente) et casse
  // les dépendances en aval — Swap lit `btcBalances[indexIn]` puis
  // compare la référence dans ses propres `useMemo`.
  const btcBalances = useMemo(
    () => tokens.map((_, i) => data?.[i] as ReadEntry | undefined),
    [data, tokens]
  );
  const mrnBalance = data?.[3] as ReadEntry | undefined;
  const refundBalance = data?.[4] as ReadEntry | undefined;

  return {
    btcBalances,
    mrnBalance,
    refundBalance,
    isLoading,
    // V.4/bug-race — refetch exposé pour que les flows multi-tx (Swap)
    // puissent forcer un re-read ciblé des soldes APRÈS settle, au lieu
    // de `refetchQueries()` global qui tire aussi les constants, fees,
    // auction, etc.
    refetch,
    // Deux niveaux d'erreur replies en un : la requete globale peut mourir
    // (noeud injoignable), ou une entree individuelle peut echouer pendant
    // que ses voisines reussissent (cf. web3-libs-seen, "two error levels").
    error: error ?? data?.find((entry) => entry.status === 'failure')?.error
  };
}