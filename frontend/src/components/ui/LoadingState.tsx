import type { ReactNode } from 'react';
import Panel from '@/components/Panel';

type LoadingStateProps = {
  title?: string;
  description?: string;
  icon?: ReactNode;
};

/**
 * Merion loading state — uniform placeholder while a read is in flight.
 *
 * Same surface as every other state in this set (Panel Slate, H5 title, body
 * description). An optional contour icon sits on the left; geometry stays
 * simple per brand book §8.
 *
 * The brief calls `LoadingState` a generic placeholder for reads in flight,
 * not for empty data — an empty reserves array is not a loading state.
 */
export function LoadingState({
  title = 'Loading…',
  description,
  icon,
}: LoadingStateProps) {
  return (
    <Panel>
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

export default LoadingState;