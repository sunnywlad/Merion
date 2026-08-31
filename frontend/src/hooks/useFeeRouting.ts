import { useMemo } from 'react';
import { useMerionReadContracts } from '@/hooks/useMerionReadContracts';
import { useDeployedChainId } from '@/hooks/useDeployedChainId';
import { useConstants } from '@/hooks/useConstants';
import { useAuctionState } from '@/hooks/useAuctionState';
import { poolAbi } from '@/constants/abi';
import { ZERO_ADDRESS } from '@/hooks/_constants';
import type { FeeRouting } from '@/lib/bands';

/**
 * Tout ce qu'il faut pour reproduire comment `Pool.swap` finance les reserves.
 *
 * Le partage est delibere. Ce qui ne change jamais (FEE_DEN, NOMINAL_FEE_NUM, PROTOCOL_FEE_BPS,
 * SPLIT_DEN) vient de `useConstants`, lu une fois par session. Ce qui bouge aux frontieres de
 * mandat (feeNum, lastSetFeeEpoch, le gestionnaire en poste) est le multicall propre a ce hook,
 * porte sur l'epoque courante et relu seulement quand elle change.
 *
 * Trois entrees, un aller-retour : l'epoque vient de `useAuctionState()` (deja pollee par
 * AuctionBar toutes les 15 s), donc pas lue deux fois. scopeKey sur l'epoque + staleTime
 * infini = une lecture par mandat au lieu d'une par minute.
 *
 * Rend `undefined` tant que tous les termes ne sont pas arrives : un garde sans donnee se tait.
 */
export function useFeeRouting(): {
  routing: FeeRouting | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const { pool } = useDeployedChainId();
  const {
    feeDen: feeDenEntry,
    nominalFeeNum: nominalEntry,
    protocolFeeBps: protocolEntry,
    splitDen: splitEntry
  } = useConstants();

  // lu par mandat
  const auction = useAuctionState();
  const epoch = auction.currentEpoch?.status === 'success'
    ? auction.currentEpoch.result
    : undefined;

  const { data, isLoading, error } = useMerionReadContracts({
    contracts: [
      { address: pool, abi: poolAbi, functionName: 'feeNum', args: [] },
      { address: pool, abi: poolAbi, functionName: 'lastSetFeeEpoch', args: [] },
      { address: pool, abi: poolAbi, functionName: 'manager', args: [] }
    ] as const,
    scopeKey: epoch?.toString(),
    query: {
      enabled: epoch !== undefined,
      staleTime: Infinity
    }
  });

  const read = <T,>(i: number): T | undefined => {
    const entry = data?.[i];
    return entry?.status === 'success' ? (entry.result as T) : undefined;
  };

  const feeDen = feeDenEntry?.status === 'success' ? feeDenEntry.result : undefined;
  const nominalFeeNum = nominalEntry?.status === 'success' ? nominalEntry.result : undefined;
  const protocolFeeBps = protocolEntry?.status === 'success' ? protocolEntry.result : undefined;
  const splitDen = splitEntry?.status === 'success' ? splitEntry.result : undefined;

  const feeNum = read<bigint>(0);
  const lastSetFeeEpoch = read<bigint>(1);
  const manager = read<`0x${string}`>(2);

  // Perf E — `useMemo([feeDen, nominalFeeNum, feeNum, lastSetFeeEpoch,
  // epoch, manager, protocolFeeBps, splitDen])` : sans ça, `routing` est
  // un nouvel objet à chaque rendu et casse la mémoïsation en aval
  // (Swap: `reservesAfterSwap` est recalculé pour rien à chaque render).
  const routing: FeeRouting | undefined = useMemo(
    () =>
      feeDen !== undefined && nominalFeeNum !== undefined &&
      protocolFeeBps !== undefined && splitDen !== undefined &&
      feeNum !== undefined && lastSetFeeEpoch !== undefined &&
      epoch !== undefined && manager !== undefined
        ? {
            feeDen,
            nominalFeeNum,
            feeNum,
            // Les deux conditions sont resolues ici pour que `lib/bands.ts` reste
            // de l'arithmetique bigint pure, sans jamais manipuler d'adresse.
            feeSetThisEpoch: lastSetFeeEpoch === epoch,
            hasManager: manager !== ZERO_ADDRESS,
            protocolFeeBps,
            splitDen
          }
        : undefined,
    [feeDen, nominalFeeNum, feeNum, lastSetFeeEpoch, epoch, manager, protocolFeeBps, splitDen]
  );

  return { routing, isLoading, error: error ?? null };
}
