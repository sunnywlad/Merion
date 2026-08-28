'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_LINKS = [
  { href: '/swap', label: 'Swap' },
  { href: '/pool', label: 'Pool' },
  { href: '/tools', label: 'Tools' },
] as const;

/**
 * Merion navbar — chrome du haut, présent sur toutes les pages (le `app/layout.tsx`
 * racine la monte au-dessus de `{children}`).
 *
 * Marque à gauche, liens applicatifs au centre, bouton de connexion à droite.
 * L'onglet actif est souligné en Merion Blue (cf. brand book §7, onglets).
 * Couleurs et tailles viennent des tokens posés par II.1.
 */
export default function Navbar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 h-16 bg-midnight border-b border-cloud/5">
      <div className="h-full flex items-center justify-between px-6 gap-8">
        <Link
          href="/"
          className="text-h5 font-semibold text-cloud hover:text-white transition-colors"
        >
          Merion
        </Link>

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
      </div>
    </header>
  );
}
