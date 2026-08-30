import Panel from '@/components/Panel';

/**
 * Etat « pool en pause » — le flag `paused` du pool est actif, swaps et operations de
 * liquidite sont temporairement suspendus.
 *
 * Ton : warning (brand book §2), signale par une bordure gauche warning, meme si une pause est
 * un etat operationnel normal, pas un echec. Reserves et enchere restent visibles.
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
