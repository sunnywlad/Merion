import { useCallback } from 'react';
import { useReadContracts } from 'wagmi';
import { useAddresses } from '@/hooks/useAddresses';
import { poolAbi } from '@/constants/abi';

// I.5 — `effectiveFeeNum(i, j)` sur les six couples ordonnés, en un multicall.
//
// POURQUOI SIX LECTURES ET NON UNE : le tarif réellement payé dépend de la
// DIRECTION du swap. `effectiveFeeNum` surcharge le sens qui aggrave le
// déséquilibre et laisse l'autre au tarif de base. Un panneau qui n'afficherait
// qu'un chiffre mentirait donc pour cinq des six directions. Le panneau montre
// la base et signale les directions surchargées ; le formulaire de swap lit le
// couple qu'il utilise.
//
// C'est aussi la fin de la migration commencée en I.1 : plus rien ne se lit
// depuis `feeNum`, et le tarif affiché est celui qu'un swap paie vraiment.

// Les couples ordonnés (i, j), i ≠ j. L'ordre est figé pour que l'index dans
// le multicall soit dérivable sans chercher.
export const FEE_PAIRS = [
  [0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1]
] as const satisfies readonly (readonly [number, number])[];

const pairIndex = (indexIn: number, indexOut: number) =>
  FEE_PAIRS.findIndex(([i, j]) => i === indexIn && j === indexOut);

export function useEffectiveFees() {
  const { pool } = useAddresses();
  const { data, isLoading, error, queryKey } = useReadContracts({
    contracts: FEE_PAIRS.map(([i, j]) => ({
      address: pool,
      abi: poolAbi,
      functionName: 'effectiveFeeNum',
      args: [BigInt(i), BigInt(j)]
    } as const)),
    // lisse les allers-retours onglet, plan §6 RPC
    query: { staleTime: 5_000 }
  });

  // Lecture par direction : ce que le formulaire de swap consomme. `undefined`
  // couvre l'entrée en échec aussi bien que le chargement, et l'appelant décide
  // quoi en faire, comme partout ailleurs dans ce front.
  // Perf E — `useCallback([data])` : sans ça, `feeFor` est une nouvelle
  // fermeture à chaque rendu, et le `useMemo`/`useEffect` qui en dépend
  // côté Swap (via `effectiveFeeNum = feeFor(indexIn, indexOut)`) reçoit
  // une référence qui change sans que la donnée ne change.
  const feeFor = useCallback(
    (indexIn: number, indexOut: number) => {
      const entry = data?.[pairIndex(indexIn, indexOut)];
      return entry?.status === 'success' ? entry.result : undefined;
    },
    [data]
  );

  // L'échec de CETTE direction, et non le premier échec du lot : le formulaire
  // de swap ne parle que du couple qu'il utilise, et un message nommant une
  // direction pour rapporter l'échec d'une autre serait faux.
  // Perf E — `useCallback([data])` : cf. `feeFor` ci-dessus.
  const errorFor = useCallback(
    (indexIn: number, indexOut: number) => {
      const entry = data?.[pairIndex(indexIn, indexOut)];
      return entry?.status === 'failure' ? entry.error : undefined;
    },
    [data]
  );

  const values = (data ?? [])
    .map((entry) => entry?.status === 'success' ? entry.result : undefined)
    .filter((value): value is bigint => value !== undefined);

  // Le minimum est la base du mandat, le maximum est la base surchargée : la
  // surcharge est active dès qu'ils diffèrent, sans avoir à relire les réserves
  // ni à reproduire la comparaison de bande morte côté front.
  const base = values.length > 0 ? values.reduce((a, b) => a < b ? a : b) : undefined;
  const worst = values.length > 0 ? values.reduce((a, b) => a > b ? a : b) : undefined;

  // Les directions effectivement surchargées, nommées pour l'affichage.
  const surcharged = FEE_PAIRS
    .filter(([i, j]) => {
      const fee = feeFor(i, j);
      return base !== undefined && fee !== undefined && fee > base;
    });

  return {
    data,
    feeFor,
    errorFor,
    base,
    worst,
    surcharged,
    isLoading,
    error,
    queryKey
  };
}
