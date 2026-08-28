import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import { WalletNotConnectedState } from './WalletNotConnectedState';
import { WrongNetworkState } from './WrongNetworkState';
import { PoolPausedState } from './PoolPausedState';
import { MandateNoManagerState } from './MandateNoManagerState';

/**
 * Discriminated union of the six app states the boundary can render.
 *
 * Each branch carries the minimum data its state component needs. The caller
 * is responsible for assembling this object from the hooks it already has;
 * the boundary stays dumb and does no reads of its own.
 */
export type AppState =
  | { kind: 'loading'; title?: string; description?: string }
  | {
      kind: 'error';
      title?: string;
      description?: string;
      // Underlying error message, rendered muted under the description for debug.
      cause?: string;
      retry?: () => void;
    }
  | { kind: 'wallet-not-connected' }
  | { kind: 'wrong-network' }
  | { kind: 'pool-paused' }
  | { kind: 'mandate-no-manager' };

/**
 * Merion AppStateBoundary — orchestrates the six uniform state components.
 *
 * The application components compute their `AppState` from what they already
 * read and pass it here when the state is not nominal. When the state IS
 * nominal they don't call this boundary at all; their normal rendering runs.
 *
 * This file is the single switch point; no application component imports a
 * state component directly. The exception is `MandatePanel`, which uses
 * `MandateNoManagerState` inline because that branch is one line of HTML, not
 * a layout substitution.
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
          cause={state.cause}
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
