import Link from 'next/link';
import NavbarClient from './NavbarClient';
import AppkitButton from './AppkitButton';

/**
 * Merion navbar — chrome du haut, présent sur les pages applicatives
 * (monté par `app/(app)/layout.tsx`).
 *
 * Coque server component : tout ce qui est statique (logo, mise en
 * page du header) vit ici. Les bits dynamiques (lien actif +
 * `appkit-button`) sont délégués aux feuilles client `NavbarClient`
 * (nav centrale) et `AppkitButton` (bouton à droite). Le split évite
 * que la landing marketing (`app/(marketing)/`) ne charge AppKit.
 *
 * Mise en page : grille à 3 colonnes `1fr | auto | 1fr`. Le logo
 * occupe la colonne gauche, les liens applicatifs la colonne
 * centrale, le bouton de connexion la colonne droite. Les deux `1fr`
 * absorbent l'espace restant de façon symétrique, ce qui force les
 * liens à se centrer **sur la largeur réelle du viewport** — alignés
 * sur l'axe vertical du panneau principal rendu en dessous (le main
 * est lui-même centré entre les deux rails `Sidebar | main |
 * RightSidebar` du layout applicatif). Sans cette symétrie, le centrage
 * se ferait entre le logo et le bouton, donc décalé du centre du
 * viewport.
 *
 * Couleurs et tailles viennent des tokens posés par II.1.
 */
export default function Navbar() {
  return (
    <header className="sticky top-0 z-50 h-16 bg-midnight border-b border-cloud/5">
      <div className="h-full grid grid-cols-[1fr_auto_1fr] items-center px-6 gap-8">
        <Link
          href="/"
          className="flex items-center gap-2 justify-self-start mt-2 hover:text-white transition-colors"
        >
          <img
            src="/merion-logo.svg"
            alt="Merion"
            className="h-9 w-9 [filter:brightness(0)_invert(1)]"
          />
          <p className="text-h3 font-semibold uppercase tracking-[0.2em] text-cloud">
            Merion
          </p>
        </Link>

        <NavbarClient />

        <div className="justify-self-end">
          <AppkitButton />
        </div>
      </div>
    </header>
  );
}
