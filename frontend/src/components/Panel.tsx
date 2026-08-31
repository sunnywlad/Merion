import type { ReactNode } from 'react';

export type PanelTone = 'default' | 'muted';

type PanelProps = {
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  tone?: PanelTone;
  className?: string;
};

const TONE_BG: Record<PanelTone, string> = {
  default: 'bg-midnight',
  muted: 'bg-slate',
};

/**
 * Merion panel — habillage de surface. Consomme les tokens posés par II.1
 * (Midnight / Slate pour le fond, IBM Plex pour la typo).
 *
 * Surfaces :
 *   - fond Slate `#1A2235`, rayon 8 px (0.5 rem), bordure 1 px Slate
 *     légèrement éclairci (mix Slate + 8 % Cloud)
 *   - pas d'ombre portée
 *
 * Hiérarchie : un titre de carte est H4 (24 px Medium). C'est
 * ce que les panneaux applicatifs (`Swap`, `Add Liquidity`,
 * `Remove Liquidity`, `Faucet`, `Get MRN`) portent.
 *
 * API : `title?`, `children`, `footer?`, `tone?` (`'default' | 'muted'`).
 * L'API `{ children }` reste compatible : les imports continuent de
 * fonctionner sans changement.
 */
export function Panel({
  title,
  children,
  footer,
  tone = 'default',
  className = '',
}: PanelProps) {
  return (
    <section
      className={
        `merion-panel flex flex-col rounded-lg border-[3px] border-merion-blue/40 p-4 min-w-0 ` +
        `${TONE_BG[tone]} text-cloud ${className}`
      }
    >
      {title ? (
        <header className="mb-6 text-h4 font-medium">{title}</header>
      ) : null}
      <div className="flex flex-col min-w-0 flex-1">{children}</div>
      {footer ? (
        <footer className="mt-3 border-t border-merion-blue/40 pt-3 text-small text-cloud/70">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

/**
 * @deprecated Conserver pour les imports existants ; préférez `Panel`.
 */
const PanelDefault = Panel;
export default PanelDefault;
