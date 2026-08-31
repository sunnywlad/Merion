import { useMemo } from 'react';
import { useMerionReadContracts } from '@/hooks/useMerionReadContracts';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import { poolAbi } from '@/constants/abi';
import { MANDATE_POLL_MS } from '@/hooks/_constants';

// I.6 — Les fees de gestionnaire jamais poussées pour une adresse (`feesOwed`
// est un mapping public du Pool, indexé par [manager][tokenIndex]). Lecture
// en un seul multicall des trois tokens panier, sur le même modèle que
// `useUserBalances` : champs nommés en sortie, jamais d'index magique.
//
// Comme pour `useRefund`, une seule adresse (le connecté) est lue, au même
// intervalle que le reste du panneau.
type ReadEntry = { status: 'success' | 'failure'; result?: bigint; error?: Error };

export function useManagerFees(user: `0x${string}` | undefined) {
  const { pool, tokens } = useDeployedChainId();

  const { data, isLoading, error, refetch } = useMerionReadContracts({
    contracts: [
      ...tokens.map((token) => ({
        address: pool ?? undefined,
        abi: poolAbi,
        functionName: 'feesOwed',
        args: [user!, token.index]
      }))
    ] as const,
    query: {
      enabled: pool !== null && user !== undefined,
      refetchInterval: MANDATE_POLL_MS
    }
  });

  // `data` est un tuple wagmi à typage conditionnel profond ; on l'aplatit
  // en `readonly ReadEntry[]` (tous nos retours sont des `uint256`/bigint)
  // pour couper l'instanciation récursive au moment de l'indexation
  // dynamique `data?.[i]`. Miroir du cast fait dans `useUserBalances`.
  const raw = data as readonly ReadEntry[] | undefined;
  // Montant dû par token (bigint, 8 décimales panier), indexé par
  // `tokenIndex`. Un échec de lecture individuelle retombe sur 0n pour ne
  // pas planter l'affichage du total.
  const perToken = useMemo(
    () => tokens.map((_, i) => raw?.[i]?.result ?? 0n),
    [raw, tokens]
  );
  // Total agrégé des trois tokens panier, en unités BTC (1:1 entre les
  // wrappers). C'est la somme présentée à l'écran et réclamée en une seule
  // passe par `claimManagerFees` sur chaque token non vide.
  // `undefined` tant que la lecture n'a pas résolu (miroir de `refund.data`
  // dans `useRefund`), puis la somme. La ligne UI affiche « — » en attendant.
  const total = useMemo(
    () => (raw ? perToken.reduce((a, b) => a + b, 0n) : undefined),
    [raw, perToken]
  );

  return {
    perToken,
    total,
    isLoading,
    // Deux niveaux d'erreur repliés en un, comme dans `useUserBalances`.
    // `raw` (aplati) évite l'instanciation profonde de `data`.
    error: error ?? raw?.find((entry) => entry.status === 'failure')?.error,
    refetch
  };
}
