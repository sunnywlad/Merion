import Panel from '@/components/Panel';

/**
 * Merion pool-paused state — the pool's `paused` flag is on, swaps and
 * liquidity operations are temporarily suspended.
 *
 * The visual stays neutral (not Danger): a pause is a normal operational
 * state, not a failure. The UI keeps mounting so the user can keep an eye on
 * reserves and the auction bar above the fold.
 */
export function PoolPausedState() {
  return (
    <Panel>
      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-4 min-w-0"
      >
        <div className="flex flex-col gap-1 min-w-0">
          <h3 className="text-h4 font-medium text-cloud">Pool paused</h3>
          <p className="text-body text-cloud/70">
            Swaps, deposits and withdrawals are suspended while the pool is
            paused. Reserves and the auction stay visible.
          </p>
        </div>
      </div>
    </Panel>
  );
}

export default PoolPausedState;