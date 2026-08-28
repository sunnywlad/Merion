import Panel from '@/components/Panel';
import { EXPECTED_CHAIN_ID, EXPECTED_CHAIN_NAME } from './deployment';

/**
 * Merion wrong-network state — wallet connected but on a chain other than the
 * one the pool is deployed on.
 *
 * The expected chain lives in `./deployment` (single source of truth). The CTA
 * reuses the project's `appkit-button` web component; the network switch itself
 * is not yet wired on the app side — see the OUVERT note in the task report.
 *
 * Tone: warning (brand book §2), signalled here with a left warning border.
 */
export function WrongNetworkState() {
  return (
    <Panel className="max-w-lg">
      <div
        role="alert"
        className="flex items-start gap-4 min-w-0 border-l-2 border-warning pl-4"
      >
        <div className="flex flex-col gap-3 min-w-0">
          <h3 className="text-h4 font-medium text-cloud">Wrong network</h3>
          <p className="text-body text-cloud/70">
            This pool is deployed on {EXPECTED_CHAIN_NAME} (chain ID{' '}
            {EXPECTED_CHAIN_ID}). Switch networks in your wallet to continue.
          </p>
          <div className="pt-1">
            <appkit-button balance="hide" />
          </div>
        </div>
      </div>
    </Panel>
  );
}
