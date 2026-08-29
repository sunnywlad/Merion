import { useAddresses } from '@/hooks/useAddresses';
import { poolAbi } from '@/constants/abi';
import { MANDATE_POLL_MS } from '@/hooks/_constants';
import { useReadContract } from 'wagmi';

// The pool's `paused` flag. The owner pauses swaps and deposits and nothing
// else (C4: he cannot move the fee, the reserves or a band), so a paused pool
// rejects every swap, addLiquidity and removeLiquidity the front can build.
//
// Polled rather than read once: pausing is an operational act that happens
// while the page is open, and a user who loaded the form before the pause
// would otherwise sign into a revert. Short interval, single boolean.
//
// The read does not depend on a connected wallet — it is a plain public
// read — so the forms can show the paused state while disconnected too.
export function usePoolPaused() {
  const { pool } = useAddresses();
  return useReadContract({
    address: pool,
    abi: poolAbi,
    functionName: 'paused',
    args: [],
    query: { refetchInterval: MANDATE_POLL_MS }
  });
}
