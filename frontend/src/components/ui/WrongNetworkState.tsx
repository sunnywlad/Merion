import Panel from '@/components/Panel';
import { SUPPORTED_CHAINS_LABEL } from './deployment';

/**
 * Etat « mauvais reseau » — wallet connecte mais sur une chaine autre que celle du pool.
 *
 * La chaine attendue vit dans `./deployment` (source de verite unique). Le CTA reutilise le
 * web component `appkit-button` ; la bascule de reseau n'est pas encore cablee cote app (note OUVERT).
 *
 * Ton : warning (brand book §2), bordure gauche warning.
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
            Merion is deployed on {SUPPORTED_CHAINS_LABEL}. Switch to one of them
            in your wallet to continue.
          </p>
          <div className="pt-1">
            <appkit-button balance="hide" />
          </div>
        </div>
      </div>
    </Panel>
  );
}
