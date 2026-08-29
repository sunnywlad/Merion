'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_LINKS = [
  { href: '/swap', label: 'Swap' },
  { href: '/pool', label: 'Pool' },
  { href: '/tools', label: 'Tools' },
] as const;

/**
 * Feuille client du Navbar — dynamic bits only.
 *
 * Détachée de la coque server (`Navbar.tsx`) pour qu'aucun JS client
 * ne soit bundlé sur la landing marketing (`app/(marketing)/`), où ce
 * composant n'est jamais monté. Cf. plan perf-frontend §3, Étape C.
 *
 * Deux responsabilités client :
 *  1. `usePathname()` pour souligner l'onglet actif (Merion Blue).
 *  2. `<appkit-button>` — composant web3 ; déclenche le chargement
 *     d'AppKit (déjà présent via les `Providers` de `(app)/layout.tsx`).
 */
export default function NavbarClient() {
  const pathname = usePathname();

  return (
    <>
      <nav className="flex items-center gap-6">
        {NAV_LINKS.map(({ href, label }) => {
          const active = pathname === href || pathname?.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={
                `text-body transition-colors ` +
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

      <appkit-button balance="hide" />
    </>
  );
}
