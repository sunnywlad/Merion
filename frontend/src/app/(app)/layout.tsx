import Sidebar from '@/components/Sidebar';
import AuctionBar from '@/components/AuctionBar';

/**
 * Coquille applicative — groupe `(app)` (pas de segment d'URL).
 *
 * Structure :
 *   [Navbar]            ← posée par le `app/layout.tsx` racine, pas répétée
 *   [AuctionBar]        ← sous-navbar, au-dessus du pli
 *   [Sidebar | <main>]  ← gauche lecture seule / droite contenu de page
 *
 * Typage manuel : `LayoutProps<"/">` n'est pas garanti pour un groupe `(app)`
 * au moment de la compilation (cf. etat.md, pièges vérifiés). On type à la main.
 */
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 min-h-0">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <AuctionBar />
        <main className="flex-1 min-w-0 p-6">{children}</main>
      </div>
    </div>
  );
}
