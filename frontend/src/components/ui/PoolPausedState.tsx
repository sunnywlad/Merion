import Panel from '@/components/Panel';

/**
 * Merion pool-paused state — the pool's `paused` flag is on, swaps and
 * liquidity operations are temporarily suspended.
 *
 * Tone: warning (brand book §2), signalled here with a left warning border
 * even though a pause is a normal operational state, not a failure.
 * Reserves and the auction stay visible so the user can keep an eye on
 * them.
 */
export function PoolPausedState() {
  return (
    <Panel className="max-w-lg">
      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-4 min-w-0 border-l-2 border-warning pl-4"
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
