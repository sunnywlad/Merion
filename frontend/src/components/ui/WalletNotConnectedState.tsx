import Panel from '@/components/Panel';

/**
 * Etat « wallet non connecte » — garde une action qui exige un signataire.
 *
 * Le CTA reutilise le web component `appkit-button` du projet, celui que la Navbar monte en
 * haut a droite. Il ouvre la modale de connexion AppKit/Reown ; pas de nouveau flux ici.
 */
export function WalletNotConnectedState() {
  return (
    <Panel className="max-w-lg">
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
