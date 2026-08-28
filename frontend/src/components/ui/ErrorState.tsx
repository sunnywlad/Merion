import type { ReactNode } from 'react';
import Panel from '@/components/Panel';
import { Button } from './Button';

type ErrorStateProps = {
  title?: string;
  description?: string;
  // Optional underlying error message, kept in a smaller, muted line so the
  // user-facing description stays legible. Debug-only detail.
  cause?: string;
  icon?: ReactNode;
  retry?: () => void;
};

/**
 * Merion read error state — surfaced when a contract read fails (timeout,
 * revert, RPC down).
 *
 * Carries the same surface as `LoadingState`; the difference is `tone=danger`
 * on the icon, an optional `retry` action that re-runs the failing read.
 * The retry callback comes from the caller; the boundary is dumb.
 */
export function ErrorState({
  title = 'Could not read on-chain data',
  description,
  cause,
  icon,
  retry,
}: ErrorStateProps) {
  return (
    <Panel>
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
          {cause ? (
            <p className="text-small text-cloud/60">
              <span className="text-neutral">Cause:</span> {cause}
            </p>
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

export default ErrorState;