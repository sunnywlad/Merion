import type { ReactNode } from 'react';
import Panel from '@/components/Panel';

type LoadingStateProps = {
  title?: string;
  description?: string;
  icon?: ReactNode;
};

/**
 * Etat de chargement Merion — placeholder uniforme pendant qu'une lecture est en vol.
 *
 * Meme surface que les autres etats du lot (Panel Slate, titre H4, description body). Icone de
 * contour optionnelle a gauche ; geometrie simple.
 *
 * `LoadingState` est un placeholder pour les lectures en vol, pas pour des donnees vides :
 * un tableau de reserves vide n'est pas un etat de chargement.
 */
export function LoadingState({
  title = 'Loading…',
  description,
  icon,
}: LoadingStateProps) {
  return (
    <Panel className="max-w-lg">
      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-4 min-w-0"
      >
        {icon ? <div className="shrink-0 text-cloud/70">{icon}</div> : null}
        <div className="flex flex-col gap-1 min-w-0">
          <h3 className="text-h4 font-medium text-cloud">{title}</h3>
          {description ? (
            <p className="text-body text-cloud/70">{description}</p>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
