'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_LINKS = [
  { href: '/swap', label: 'Swap' },
  { href: '/pool', label: 'Pool' },
  { href: '/auction', label: 'Auction' },
  { href: '/tools', label: 'Tools' },
] as const;

/**
 * Feuille client du Navbar — parties dynamiques uniquement.
 *
 * Détachée de la coque server (`Navbar.tsx`) pour qu'aucun JS client
 * ne soit bundlé sur la landing marketing (`app/(marketing)/`), où ce
 * composant n'est jamais monté. Cf. plan perf-frontend §3, Étape C.
 *
 * Responsabilité client unique : `usePathname()` pour souligner
 * l'onglet actif en Merion Blue. Le bouton AppKit est rendu par
 * `AppkitButton` (autre feuille client), chacun posant sa colonne dans
 * la grille `1fr | auto | 1fr` du Navbar — voir `Navbar.tsx`.
 */
export default function NavbarClient() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-16">
      {NAV_LINKS.map(({ href, label }) => {
        const active = pathname === href || pathname?.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            className={
              `text-h5 transition-colors ` +
              (active
                ? 'text-cloud underline underline-offset-8 decoration-2 decoration-merion-blue'
                : 'text-neutral hover:text-cloud')
            }
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
