import Link from 'next/link';
import NavbarClient from './NavbarClient';

/**
 * Merion navbar — chrome du haut, présent sur les pages applicatives
 * (monté par `app/(app)/layout.tsx`).
 *
 * Coque server component : tout ce qui est statique (logo, layout du
 * header) vit ici. Les bits dynamiques (lien actif + `appkit-button`)
 * sont délégués à la feuille client `NavbarClient`. Le split évite
 * que la landing marketing (`app/(marketing)/`) ne charge AppKit —
 * cf. plan perf-frontend §3, Étape C.
 *
 * Marque à gauche, liens applicatifs au centre, bouton de connexion à droite.
 * L'onglet actif est souligné en Merion Blue (cf. brand book §7, onglets).
 * Couleurs et tailles viennent des tokens posés par II.1.
 */
export default function Navbar() {
  return (
    <header className="sticky top-0 z-50 h-16 bg-midnight border-b border-cloud/5">
      <div className="h-full flex items-center px-6 gap-8">
        <Link
          href="/"
          className="flex items-center gap-2 mt-2 hover:text-white transition-colors"
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
      </div>
    </header>
  );
}
