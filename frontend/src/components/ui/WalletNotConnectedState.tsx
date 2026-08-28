import Panel from '@/components/Panel';

/**
 * Merion wallet-not-connected state — gates an action that needs a signer.
 *
 * The CTA reuses the project's existing `appkit-button` web component, the
 * same one the Navbar mounts at the top right. Clicking it opens the
 * AppKit/Reown connection modal; this component does not invent a new
 * connection flow.
 */
export function WalletNotConnectedState() {
  return (
    <Panel>
      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-4 min-w-0"
      >
        <div className="flex flex-col gap-3 min-w-0">
          <h3 className="text-h4 font-medium text-cloud">Wallet not connected</h3>
          <p className="text-body text-cloud/70">
            Connect a wallet to interact with the pool. Reads stay available
            without one.
          </p>
          <div className="pt-1">
            <appkit-button balance="hide" />
          </div>
        </div>
      </div>
    </Panel>
  );
}

export default WalletNotConnectedState;