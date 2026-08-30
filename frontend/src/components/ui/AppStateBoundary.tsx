import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import { WalletNotConnectedState } from './WalletNotConnectedState';
import { WrongNetworkState } from './WrongNetworkState';
import { PoolPausedState } from './PoolPausedState';
import { MandateNoManagerState } from './MandateNoManagerState';

/**
 * Union discriminee des six etats d'app que la borne peut rendre.
 *
 * Chaque branche porte le minimum de donnees dont son composant a besoin. L'appelant assemble
 * cet objet a partir des hooks qu'il a deja ; la borne reste passive et ne lit rien elle-meme.
 */
export type AppState =
  | { kind: 'loading'; title?: string; description?: string }
  | {
      kind: 'error';
      title?: string;
      description?: string;
      retry?: () => void;
    }
  | { kind: 'wallet-not-connected' }
  | { kind: 'wrong-network' }
  | { kind: 'pool-paused' }
  | { kind: 'mandate-no-manager' };

/**
 * Merion AppStateBoundary — orchestre les six composants d'etat uniformes.
 *
 * Les composants applicatifs calculent leur `AppState` a partir de ce qu'ils lisent deja et le
 * passent ici quand l'etat n'est pas nominal. Quand il l'est, ils n'appellent pas la borne du tout.
 *
 * Ce fichier est le point d'aiguillage unique ; aucun composant applicatif n'importe un composant
 * d'etat directement. Exception : `MandatePanel`, qui utilise `MandateNoManagerState` inline, cette
 * branche etant une ligne de HTML, pas une substitution de layout.
 */
export function AppStateBoundary({ state }: { state: AppState }) {
  switch (state.kind) {
    case 'loading':
      return (
        <LoadingState title={state.title} description={state.description} />
      );
    case 'error':
      return (
        <ErrorState
          title={state.title}
          description={state.description}
          retry={state.retry}
        />
      );
    case 'wallet-not-connected':
      return <WalletNotConnectedState />;
    case 'wrong-network':
      return <WrongNetworkState />;
    case 'pool-paused':
      return <PoolPausedState />;
    case 'mandate-no-manager':
      return <MandateNoManagerState />;
  }
}
