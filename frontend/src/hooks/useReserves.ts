import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { useAddresses } from '@/hooks/useAddresses';
import {poolAbi} from '@/constants/abi';

export function useReserves() {
  const { pool, tokens } = useAddresses();
  const { data, isLoading, error, refetch, queryKey } = useReadContracts({
    contracts: [...tokens.map((token) => {
      return {
        address: pool,
        abi: poolAbi,
        functionName: 'reserves',
        args: [token.index]
      } as const}),
      {
        address: pool,
        abi: poolAbi,
        functionName: 'totalSupply',
        args: []
      }
    ] as const,
    // lisse les allers-retours onglet, plan §6 RPC
    query: { staleTime: 5_000 }
  })
  // R3/B.2 — Aplatissement typé en tuple `[r0, r1, r2] | undefined` :
  // les consommateurs lisent `reserves[0]`, `reserves[1]`, `reserves[2]`
  // directement, sans refaire le `map/filter` local. Le tuple force
  // l'assertion que les 3 entrées ont chargé, ce qui bloque la dérive
  // à la 4e jambe.
  // Perf E — `useMemo([data])` : sans ça, `reserves` est un nouveau tuple
  // à chaque rendu (même contenu, identité différente) et casse les
  // dépendances d'effet qui le comparent en `===` côté Swap.
  const slice = data?.slice(0, 3);
  const reserves: [bigint, bigint, bigint] | undefined = useMemo(
    () =>
      slice?.[0]?.status === 'success' &&
      slice?.[1]?.status === 'success' &&
      slice?.[2]?.status === 'success'
        ? [slice[0].result, slice[1].result, slice[2].result]
        : undefined,
    [slice]
  );
  return {
    reserves,
    // `entries` reste exposé pour les consommateurs qui ont besoin du
    // `.error` par jambe (logging per-line dans Swap/AddLiquidity/
    // RemoveLiquidity, affichage par token dans Reserves/PoolRail).
    // Les valeurs sont sur `reserves[i]` ; `.error` n'est lisible que
    // via `entries[i]?.error`.
    entries: slice,
    supply: data?.[3],
    isLoading,
    error,
    // V.4/bug-race — refetch exposé pour que les flows multi-tx (Swap,
    // AddLiquidity, RemoveLiquidity) puissent forcer un re-read ciblé
    // des réserves APRÈS settle, au lieu de `refetchQueries()` global.
    refetch,
    queryKey
  }
}
