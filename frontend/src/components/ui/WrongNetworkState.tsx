import Panel from '@/components/Panel';

/**
 * Merion wrong-network state — wallet connected but on a chain other than the
 * one the pool is deployed on.
 *
 * The expected chain is hard-coded to `31337` (Anvil local), matching
 * `frontend/src/constants/addresses.ts`. The CTA reuses the project's
 * `appkit-button` web component; the network switch itself is not yet wired
 * on the app side — see the OUVERT note in the task report.
 */
const EXPECTED_CHAIN_ID = 31337;

export function WrongNetworkState() {
  return (
    <Panel>
      <div
        role="alert"
        className="flex items-start gap-4 min-w-0"
      >
        <div className="flex flex-col gap-3 min-w-0">
          <h3 className="text-h4 font-medium text-cloud">Wrong network</h3>
          <p className="text-body text-cloud/70">
            This pool is deployed on chain ID {EXPECTED_CHAIN_ID}. Switch
            networks in your wallet to continue.
          </p>
          <div className="pt-1">
            <appkit-button balance="hide" />
          </div>
        </div>
      </div>
    </Panel>
  );
}

export default WrongNetworkState;