import Providers from '@/app/providers';
import Navbar from '@/components/Navbar';
import Sidebar from '@/components/Sidebar';
import RightSidebar from '@/components/RightSidebar';
import { ChainNowProvider } from '@/hooks/useChainNow';

/**
 * Coquille applicative — groupe `(app)` (pas de segment d'URL).
 *
 * C'est ici que vit le web3 : `Providers` (wagmi + react-query + AppKit)
 * enveloppe tout le sous-arbre applicatif. La landing, en
 * `app/(landing)/`, est en dehors de ce groupe et ne charge donc rien
 * de tout ça — cf. plan perf-frontend §3, Étape C.
 *
 * Structure — note d'inspiration §1 :
 *   [Navbar]                          ← h-16, fixe en haut
 *   [Rail | Colonne principale]        ← outer flex
 *     Rail : 320 px (20 rem), bg-slate, padding interne, scrolle si jamais
 *     Colonne : 1fr, gouttière 24 px (1.5 rem)
 *       [AuctionBar]                  ← barre d'enchère, pleine largeur colonne
 *       [main]                        ← wrapper centré, contenu max 640 px
 *
 * Marges extérieures : 32 px (2 rem) en haut, en bas, à droite. Le rail
 * colle au bord gauche (0 px) — sa propre marge interne fait le travail.
 *
 * La contrainte dure (note §6) : `scrollHeight ≤ innerHeight` à 1440×900
 * portefeuille connecté et données chargées, sur `/swap`, `/pool`, `/tools`.
 * Le `main` n'a pas de `overflow-y-auto` : la page ne scrolle pas quand
 * AuctionBar est repliée. Quand AuctionBar est dépliée, le défilement
 * est acceptable (ce n'est plus l'état par défaut).
 *
 * Typage manuel : `LayoutProps<"/">` n'est pas garanti pour un groupe
 * `(app)` (cf. etat.md, pièges vérifiés). On type à la main.
 */
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      <Navbar />
      <div className="flex flex-1 min-h-0 py-6 gap-5">
        <Sidebar className="w-80 shrink-0" />
        <ChainNowProvider>
          <div className="flex flex-col flex-1 min-w-0 gap-5">
            <main className="flex-1 min-w-0 flex justify-center">
              <div className="w-full max-w-[640px] flex flex-col gap-5">
                {children}
              </div>
            </main>
          </div>
        </ChainNowProvider>
        <RightSidebar className="w-80 shrink-0" />
      </div>
    </Providers>
  );
}
