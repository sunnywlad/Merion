'use client';

import { useState } from 'react';
import AuctionPanel from '@/components/AuctionPanel';

/**
 * Merion AuctionBar — sous-navbar collante, vit dans la coquille `(app)` et
 * reste au-dessus du pli sur toutes les pages applicatives.
 *
 * C'est le différenciateur du projet : il porte l'état du mandat en cours et
 * les actions d'enchère via le composant `AuctionPanel` (composant applicatif
 * préexistant, sa logique n'est pas retouchée ici).
 *
 * Hauteur : sticky top-16 pour s'aligner juste sous la Navbar du `app/layout.tsx`
 * racine (h-16 = 4 rem = 64 px).
 *
 * État replié (par défaut) : une ligne compacte au-dessus du pli, qui laisse
 * la place aux formulaires applicatifs. Le panneau complet se déplie au clic,
 * sans changer la position collante : la barre reste visible pendant le
 * défilement du contenu détaillé.
 */
export default function AuctionBar() {
  const [open, setOpen] = useState(false);

  return (
    <div className="sticky top-16 z-40 bg-slate border-b border-cloud/5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="auction-bar-panel"
        onClick={() => setOpen((v) => !v)}
        className={
          'w-full px-6 py-3 flex items-center justify-between gap-4 ' +
          'text-left text-cloud hover:bg-cloud/5 ' +
          'focus:outline-none focus-visible:border-merion-blue focus-visible:border-2 ' +
          'transition-colors duration-150'
        }
      >
        <span className="flex items-center gap-3">
          <span className="text-h5 font-medium">Auction</span>
          <span className="text-caption uppercase tracking-wide text-cloud/60">
            next mandate
          </span>
        </span>
        <span className="flex items-center gap-2 text-small text-cloud/70">
          <span>{open ? 'Hide details' : 'Show details'}</span>
          <span aria-hidden="true" className="leading-none">
            {open ? '▴' : '▾'}
          </span>
        </span>
      </button>
      {open ? (
        <div id="auction-bar-panel" className="px-6 py-4 border-t border-cloud/10">
          <AuctionPanel />
        </div>
      ) : null}
    </div>
  );
}
