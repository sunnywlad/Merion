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
 */
export default function AuctionBar() {
  return (
    <div className="sticky top-16 z-40 bg-slate border-b border-cloud/5 px-6 py-4">
      <AuctionPanel />
    </div>
  );
}
