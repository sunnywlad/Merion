import type { ReactNode } from 'react';
import Panel from '@/components/Panel';
import { Button } from './Button';

type ErrorStateProps = {
  title?: string;
  description?: string;
  icon?: ReactNode;
  retry?: () => void;
};

/**
 * Etat d'erreur de lecture Merion — affiche quand une lecture de contrat echoue (timeout,
 * revert, RPC injoignable).
 *
 * Meme surface que `LoadingState` ; la difference est `tone=danger` sur l'icone et une action
 * `retry` optionnelle qui relance la lecture. Le callback `retry` vient de l'appelant ; la borne est passive.
 */
export function ErrorState({
  title = 'Could not read on-chain data',
  description,
  icon,
  retry,
}: ErrorStateProps) {
  return (
    <Panel className="max-w-lg">
      <div
        role="alert"
        className="flex items-start gap-4 min-w-0"
      >
        {icon ? <div className="shrink-0 text-danger">{icon}</div> : null}
        <div className="flex flex-col gap-2 min-w-0">
          <h3 className="text-h4 font-medium text-cloud">{title}</h3>
          {description ? (
            <p className="text-body text-cloud/70">{description}</p>
          ) : null}
          {retry ? (
            <div className="pt-1">
              <Button level="primary" onClick={retry}>
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
