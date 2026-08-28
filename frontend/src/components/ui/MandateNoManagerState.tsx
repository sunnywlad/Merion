import Panel from '@/components/Panel';

/**
 * Merion mandate-no-manager state — the mandate exists but no manager has
 * been registered for the current epoch.
 *
 * This is the nominal case for the first epoch: there is no auction yet, the
 * pool trades at the base fee, and everything works. The tone is neutral —
 * this is not a failure, and using `danger` would mislead the user.
 */
export function MandateNoManagerState() {
  return (
    <Panel>
      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-4 min-w-0"
      >
        <div className="flex flex-col gap-1 min-w-0">
          <h3 className="text-h4 font-medium text-cloud">No manager for the current epoch</h3>
          <p className="text-body text-cloud/70">
            The pool trades at the base fee. A new auction will pick a manager
            before the next epoch starts.
          </p>
        </div>
      </div>
    </Panel>
  );
}

export default MandateNoManagerState;