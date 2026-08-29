import { useReadContracts } from 'wagmi';
import { useAddresses } from '@/hooks/useAddresses';
import { useConstants } from '@/hooks/useConstants';
import { useAuctionState } from '@/hooks/useAuctionState';
import { poolAbi } from '@/constants/abi';
import { ZERO_ADDRESS } from '@/hooks/_constants';
import type { FeeRouting } from '@/lib/bands';

/**
 * Everything needed to reproduce how `Pool.swap` funds the reserves.
 *
 * The split is deliberate. What never changes — `FEE_DEN`,
 * `NOMINAL_FEE_NUM` (immutable, constructor), `PROTOCOL_FEE_BPS` and
 * `SPLIT_DEN` (both `constant`) — comes from `useConstants` and is read once
 * for the session. What moves at mandate boundaries — `feeNum`,
 * `lastSetFeeEpoch` and the manager in office — is this hook's own
 * multicall, scoped to the current epoch and re-read only when it changes.
 *
 * Three entries, one round-trip: `manager()` is `managerOf[currentEpoch()]`,
 * but the epoch itself is sourced from `useAuctionState()` (already polled
 * by `AuctionBar` at 15 s), so we don't read it twice. `scopeKey` keyed on
 * the epoch plus `staleTime: Infinity` gives one read per mandate instead of
 * one per minute (plan §4 RPC).
 *
 * Returns `undefined` until every term has landed. A guard that has not got its
 * data says nothing rather than guessing.
 */
export function useFeeRouting(): {
  routing: FeeRouting | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const { pool } = useAddresses();
  const {
    feeDen: feeDenEntry,
    nominalFeeNum: nominalEntry,
    protocolFeeBps: protocolEntry,
    splitDen: splitEntry
  } = useConstants();

  // lu par mandat, plan §4 RPC
  const auction = useAuctionState();
  const epoch = auction.currentEpoch?.status === 'success'
    ? auction.currentEpoch.result
    : undefined;

  const { data, isLoading, error } = useReadContracts({
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

  const routing: FeeRouting | undefined =
    feeDen !== undefined && nominalFeeNum !== undefined &&
    protocolFeeBps !== undefined && splitDen !== undefined &&
    feeNum !== undefined && lastSetFeeEpoch !== undefined &&
    epoch !== undefined && manager !== undefined
      ? {
          feeDen,
          nominalFeeNum,
          feeNum,
          // Both branch conditions are resolved here so `lib/bands.ts` stays
          // pure bigint arithmetic and never has to handle an address.
          feeSetThisEpoch: lastSetFeeEpoch === epoch,
          hasManager: manager !== ZERO_ADDRESS,
          protocolFeeBps,
          splitDen
        }
      : undefined;

  return { routing, isLoading, error: error ?? null };
}
